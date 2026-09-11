"""Unit tests for the ONNX embedding clusterer's own logic - not the model.

Deliberately does not touch the network or torch: no huggingface_hub
download, no ONNX Runtime session, no sentence-transformers. It exercises the
three things this migration adds that are actually risky to get wrong -
masked mean pooling, L2 normalization, and batch/row-order bookkeeping -
against hand-computed values and fakes, per docs/onnx-migration.md.

The torch-vs-ONNX numerical equivalence check (cosine >= 0.9999 against the
real model on the real database) is the Architect's and is deliberately not
duplicated here.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.clustering import onnx_embedding as onnx_mod
from app.clustering.base import Document
from app.clustering.onnx_embedding import OnnxClusterer, _l2_normalize, _mean_pool


def test_masked_mean_pool_hand_computed():
    # Two rows, three token positions. Row 0's third position is padding with
    # a large nonzero embedding - if the mask were ignored (e.g. dividing by
    # the padded length 3 instead of the real token count 2), this would
    # change the answer and the test would catch it.
    last_hidden_state = np.array(
        [
            [[1.0, 1.0], [3.0, 1.0], [100.0, 100.0]],  # 3rd position: padding
            [[2.0, 0.0], [4.0, 2.0], [6.0, 4.0]],  # all three are real tokens
        ],
        dtype=np.float32,
    )
    attention_mask = np.array([[1, 1, 0], [1, 1, 1]], dtype=np.int64)

    pooled = _mean_pool(last_hidden_state, attention_mask)

    expected = np.array(
        [
            [(1.0 + 3.0) / 2, (1.0 + 1.0) / 2],
            [(2.0 + 4.0 + 6.0) / 3, (0.0 + 2.0 + 4.0) / 3],
        ],
        dtype=np.float32,
    )
    np.testing.assert_allclose(pooled, expected, rtol=1e-6)


def test_masked_mean_pool_all_masked_out_does_not_divide_by_zero():
    # Degenerate input: a row with no real tokens at all. The clamp inside
    # _mean_pool must keep this finite rather than raising or emitting NaN.
    last_hidden_state = np.zeros((1, 2, 3), dtype=np.float32)
    attention_mask = np.zeros((1, 2), dtype=np.int64)

    pooled = _mean_pool(last_hidden_state, attention_mask)

    assert np.all(np.isfinite(pooled))


def test_l2_normalize_rows_are_unit_norm():
    vectors = np.array([[3.0, 4.0], [1.0, 0.0], [-2.0, 2.0]], dtype=np.float32)

    normalized = _l2_normalize(vectors)

    norms = np.linalg.norm(normalized, axis=1)
    np.testing.assert_allclose(norms, [1.0, 1.0, 1.0], rtol=1e-6)


def test_l2_normalize_zero_row_does_not_divide_by_zero():
    vectors = np.zeros((1, 4), dtype=np.float32)

    normalized = _l2_normalize(vectors)

    assert np.all(np.isfinite(normalized))


class _FakeEncoding:
    def __init__(self, ids: list[int], attention_mask: list[int]) -> None:
        self.ids = ids
        self.attention_mask = attention_mask
        self.type_ids = [0] * len(ids)


class _FakeTokenizer:
    """Maps each text to a distinct token id *and* a distinct token count.

    The varying length is the point: it is what makes ``vectors()``'s
    length-bucketing actually reorder documents relative to input order
    (equal lengths would leave a stable sort a no-op, which is exactly how
    the previous version of this test missed a broken scatter-back - see
    ``test_vectors_scatter_back_is_load_bearing`` below).
    """

    def __init__(self, id_for_text: dict[str, int], length_for_text: dict[str, int]) -> None:
        self._id_for_text = id_for_text
        self._length_for_text = length_for_text

    def encode(self, text: str) -> _FakeEncoding:
        n = self._length_for_text[text]
        token_id = self._id_for_text[text]
        return _FakeEncoding([token_id] * n, [1] * n)

    def encode_batch(self, texts: list[str]) -> list[_FakeEncoding]:
        # A real tokenizer pads every row in a batch to the longest row in
        # that same batch; reproduce that so this fake batches the same way
        # production batches do.
        max_len = max(self._length_for_text[t] for t in texts)
        encodings = []
        for text in texts:
            n = self._length_for_text[text]
            token_id = self._id_for_text[text]
            pad = max_len - n
            encodings.append(
                _FakeEncoding([token_id] * n + [0] * pad, [1] * n + [0] * pad)
            )
        return encodings


class _FakeSession:
    """Stands in for onnxruntime.InferenceSession.

    Every *real* (unmasked) token position gets a one-hot vector at
    ``token_id % 384``, so the direction of a document's pooled, normalized
    output reveals which token id - and therefore which original document -
    produced it, independent of how many tokens it had or which batch it
    landed in. Padding positions get a large, wrong value in an unrelated
    dimension: if the mask were ever ignored downstream this would corrupt
    the result loudly rather than by a few float ULPs.
    """

    def run(self, output_names, inputs):
        input_ids = inputs["input_ids"]
        attention_mask = inputs["attention_mask"]
        batch, seq_len = input_ids.shape
        hidden = np.zeros((batch, seq_len, 384), dtype=np.float32)
        for row in range(batch):
            for pos in range(seq_len):
                if attention_mask[row, pos]:
                    token_id = int(input_ids[row, pos])
                    hidden[row, pos, token_id % 384] = 1.0
                else:
                    hidden[row, pos, :] = 999.0
        return [hidden]


def _make_documents(n: int) -> list[Document]:
    return [Document(id=f"a_{i}", title=f"title {i}", summary="") for i in range(n)]


def _fake_loader_for(documents: list[Document], lengths: list[int]):
    """A loader that ties each document to a distinct id and token count.

    ``lengths`` is deliberately not sorted the same way as ``documents``, so
    length-bucketing must actually move rows around for this to be a
    meaningful test.
    """
    id_for_text = {doc.text: i for i, doc in enumerate(documents)}
    length_for_text = {doc.text: n for doc, n in zip(documents, lengths)}
    fake_tokenizer = _FakeTokenizer(id_for_text, length_for_text)
    fake_session = _FakeSession()
    return lambda: (fake_session, fake_tokenizer)


def _assert_vector_belongs_to_document(vectors: np.ndarray, doc_index: int) -> None:
    expected_dim = doc_index % 384
    row = vectors[doc_index]
    assert row[expected_dim] == pytest.approx(1.0), (
        f"row {doc_index} does not carry its own document's identity - "
        f"got peak at a different dimension, consistent with a scatter-back "
        f"that wrote results in batch-processing order instead of by "
        f"original document index"
    )
    other_mass = np.sum(np.abs(row)) - abs(row[expected_dim])
    assert other_mass == pytest.approx(0.0, abs=1e-6)


def test_vectors_preserve_input_document_order_across_batches(monkeypatch):
    documents = _make_documents(5)
    # Lengths are a permutation of, not equal to, the document order, so
    # sorting by length genuinely reorders rows before batching (ascending
    # length order here is documents [1, 3, 4, 2, 0]).
    lengths = [5, 1, 4, 2, 3]
    monkeypatch.setattr(
        onnx_mod, "_load_session_and_tokenizer", _fake_loader_for(documents, lengths)
    )

    clusterer = OnnxClusterer()
    clusterer.batch_size = 2  # forces 3 onnxruntime calls for 5 documents

    vectors = clusterer.vectors(documents)

    assert vectors.shape == (5, 384)
    assert vectors.dtype == np.float32
    for i in range(5):
        _assert_vector_belongs_to_document(vectors, i)


def test_vectors_scatter_back_is_load_bearing(monkeypatch):
    """Isolates the scatter-back loop from bucketing/batching correctness.

    Verified by mutation (see report): replacing the indexed scatter-back in
    ``vectors()`` -

        for row, doc_index in enumerate(batch_indices):
            pooled[doc_index] = batch_pooled[row]

    - with a plain sequential write -

        pooled[start:start + len(batch_indices)] = batch_pooled

    - makes this test fail, because length-bucketing has already reordered
    ``batch_indices`` relative to ``range(start, start + len(batch_indices))``
    by this point. It passes again once the indexed write is restored.
    """
    documents = _make_documents(6)
    # No two adjacent-by-length documents share their original adjacency;
    # every batch of 2 straddles a document whose original index is not
    # adjacent to its batch-mates, so a sequential write would misplace it.
    lengths = [6, 1, 5, 2, 4, 3]
    monkeypatch.setattr(
        onnx_mod, "_load_session_and_tokenizer", _fake_loader_for(documents, lengths)
    )

    clusterer = OnnxClusterer()
    clusterer.batch_size = 2

    vectors = clusterer.vectors(documents)

    for i in range(6):
        _assert_vector_belongs_to_document(vectors, i)


def test_vectors_empty_input_returns_correct_shape():
    # No monkeypatch needed: the empty-input path returns before touching the
    # loader, so this genuinely never reaches the network.
    clusterer = OnnxClusterer()

    vectors = clusterer.vectors([])

    assert vectors.shape == (0, 384)
    assert vectors.dtype == np.float32
