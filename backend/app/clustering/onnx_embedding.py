"""Default clusterer: all-MiniLM-L6-v2 via ONNX Runtime, CPU only.

Produces the same vectors as ``embedding.py`` (the torch/sentence-transformers
reference implementation) without loading torch, a training framework, to run
inference on a 90 MB model. See docs/onnx-migration.md for the measured cost
and the equivalence this is required to hold.

Pipeline, matching the loaded SentenceTransformer exactly
(``Transformer -> Pooling(mean, masked) -> Normalize``):

1. Tokenize with the model's own ``tokenizer.json`` via the ``tokenizers``
   library (the same Rust WordPiece implementation sentence-transformers
   itself uses) - never hand-rolled.
2. Truncate/pad at 256 tokens. This is ``sentence_bert_config.json``'s
   ``max_seq_length`` for this model, verified against a live
   ``SentenceTransformer`` instance - *not* the tokenizer's own baked-in
   truncation (128) or its ``model_max_length`` (512), both of which are
   silently wrong for this purpose.
3. Run the fp32 ``onnx/model.onnx`` export (not the int8 variants - those
   perturb the vectors enough to threaten the 0.62 threshold).
4. Mean-pool ``last_hidden_state`` over unmasked tokens only, then L2
   normalize. Dividing by the padded sequence length instead of the
   attention-mask sum is the likely way to get this subtly wrong; it only
   shows up on short texts padded alongside longer ones in the same batch.

Model and tokenizer files come from the HF hub via ``huggingface_hub``, which
respects ``HF_HOME`` - the same cache sentence-transformers already uses
locally, and what lets a Docker build pre-warm the cache at build time.
"""

from __future__ import annotations

import importlib.util
import logging
import threading

import numpy as np

from ..config import settings
from .agglomerative import group_by_cosine
from .base import Document

log = logging.getLogger("newsprism.clustering.onnx_embedding")

#: sentence_bert_config.json's max_seq_length for all-MiniLM-L6-v2, verified
#: against a live SentenceTransformer (docs/onnx-migration.md). Not the
#: tokenizer's own defaults - see module docstring.
MAX_SEQ_LENGTH = 256

_EMBEDDING_DIM = 384

_session = None
_tokenizer = None
_load_lock = threading.Lock()


def _load_session_and_tokenizer():
    global _session, _tokenizer
    # Double-checked locking: routes.py's ingest endpoint is a sync def, so
    # FastAPI runs it in a threadpool, and nothing else serializes concurrent
    # POST /api/ingest calls. Without a lock, two overlapping first-ingests
    # would both see _session is None, both download, and both build a full
    # InferenceSession - doubling resident model memory at exactly the moment
    # this migration exists to keep that number down. The outer check keeps
    # the lock off the steady-state (already-loaded) path.
    if _session is None:
        with _load_lock:
            if _session is None:
                from huggingface_hub import hf_hub_download
                from tokenizers import Tokenizer
                import onnxruntime as ort

                log.info(
                    "loading ONNX embedding model %s on CPU", settings.embedding_model
                )
                tokenizer_path = hf_hub_download(settings.embedding_model, "tokenizer.json")
                onnx_path = hf_hub_download(settings.embedding_model, "onnx/model.onnx")

                tokenizer = Tokenizer.from_file(tokenizer_path)
                pad_id = tokenizer.token_to_id("[PAD]")
                if pad_id is None:
                    pad_id = 0
                tokenizer.enable_truncation(max_length=MAX_SEQ_LENGTH)
                # Dynamic padding to the longest sequence in each batch
                # (capped by the truncation above), not a fixed 256 - cheaper,
                # and equivalent because padded positions are excluded from
                # the mean pool by attention_mask.
                tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")

                # Memory, not speed, is the point of this migration (see
                # docs/onnx-migration.md). Measured on the real corpus:
                #   - onnxruntime's default CPU arena allocator never
                #     shrinks, so it retains the high-water mark of every
                #     batch it has ever run. Disabling it (plain alloc/free
                #     per op) cut peak RSS roughly a third on the real
                #     856-document window.
                #   - The default thread pool sizes itself to the machine's
                #     core count (24 here); pinning to 1 avoids per-thread
                #     allocator overhead that showed up in the same
                #     measurement. A single CPU core doing this workload is
                #     not latency-sensitive enough to be worth the memory.
                # Neither changes a single output value - both are execution
                # strategy, not math.
                session_options = ort.SessionOptions()
                session_options.enable_cpu_mem_arena = False
                session_options.intra_op_num_threads = 1

                # CPU only: this machine and the deploy target both have no
                # NVIDIA GPU, and onnxruntime (not onnxruntime-gpu) is the
                # only provider installed.
                session = ort.InferenceSession(
                    onnx_path,
                    sess_options=session_options,
                    providers=["CPUExecutionProvider"],
                )

                _tokenizer = tokenizer
                _session = session
    return _session, _tokenizer


def _mean_pool(last_hidden_state: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Attention-masked mean over the token axis.

    ``attention_mask`` must be summed, not the padded sequence length used, so
    padding never dilutes the average - matches
    ``sentence_transformers.models.Pooling`` exactly, clamp included.
    """
    mask = attention_mask.astype(np.float32)[:, :, None]
    summed = (last_hidden_state * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), a_min=1e-9, a_max=None)
    return summed / counts


def _l2_normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-12, a_max=None)
    return vectors / norms


class OnnxClusterer:
    name = "onnx:all-MiniLM-L6-v2"

    #: Measured on the real 855-document clustering window, full app
    #: imported, one pass per process (peak RSS / idle steady-state / headroom
    #: on a 512 MB plan): batch_size 32 -> 405.7 MB / 302.0 MB / 21%; 16 ->
    #: 357.7 MB / 300.3 MB / 30%; 8 -> 332.3 MB / 301.5 MB / 35%. Wall-clock
    #: was indistinguishable across all three, so 8 buys meaningfully more
    #: headroom for no measurable time cost. Not matched to embedding.py's
    #: batch_size=32 - batching is execution strategy, not a correctness
    #: requirement, per the length-bucketing note below.
    batch_size = 8

    def __init__(self, similarity_threshold: float | None = None) -> None:
        # Probe importability at construction time, not at first encode, so
        # the factory in __init__.py can fall back to TF-IDF before any
        # request is served rather than blowing up mid-ingest.
        for module in ("onnxruntime", "tokenizers", "huggingface_hub"):
            if importlib.util.find_spec(module) is None:
                raise ImportError(f"{module} is not installed")
        self.similarity_threshold = (
            settings.similarity_threshold
            if similarity_threshold is None
            else similarity_threshold
        )
        self.name = f"onnx:{settings.embedding_model.split('/')[-1]}"

    def vectors(self, documents: list[Document]) -> np.ndarray:
        if not documents:
            return np.zeros((0, _EMBEDDING_DIM), dtype=np.float32)

        session, tokenizer = _load_session_and_tokenizer()
        texts = [doc.text for doc in documents]
        n = len(texts)

        # Bucket by token length before batching, then scatter results back
        # to the caller's order below. A news corpus is mostly ~10-30 token
        # headlines with a handful of much longer ones; batching in input
        # order lets one long outlier pad every other row in its batch out to
        # its length, which - combined with the arena behavior noted above -
        # roughly doubled peak RSS in measurement. Pure execution-order
        # change: every row's own tokens and mask are unaffected, so this
        # cannot change any output value, only which rows are computed
        # alongside which others.
        lengths = [len(tokenizer.encode(text).ids) for text in texts]
        order = sorted(range(n), key=lambda i: lengths[i])

        pooled = np.empty((n, _EMBEDDING_DIM), dtype=np.float32)
        for start in range(0, n, self.batch_size):
            batch_indices = order[start : start + self.batch_size]
            batch_texts = [texts[i] for i in batch_indices]
            encodings = tokenizer.encode_batch(batch_texts)
            input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
            attention_mask = np.array(
                [e.attention_mask for e in encodings], dtype=np.int64
            )
            token_type_ids = np.array([e.type_ids for e in encodings], dtype=np.int64)

            (last_hidden_state,) = session.run(
                None,
                {
                    "input_ids": input_ids,
                    "attention_mask": attention_mask,
                    "token_type_ids": token_type_ids,
                },
            )
            batch_pooled = _mean_pool(last_hidden_state, attention_mask)
            for row, doc_index in enumerate(batch_indices):
                pooled[doc_index] = batch_pooled[row]

        return _l2_normalize(pooled).astype(np.float32)

    def cluster(self, documents: list[Document]) -> list[list[str]]:
        if not documents:
            return []
        vectors = self.vectors(documents)
        return group_by_cosine(
            [doc.id for doc in documents], vectors, self.similarity_threshold
        )
