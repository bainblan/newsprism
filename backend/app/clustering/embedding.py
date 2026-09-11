"""Default clusterer: sentence-transformers all-MiniLM-L6-v2 on CPU.

Semantic embeddings are the right tool here because different outlets rarely
share vocabulary when covering the same event - "Trump pledges $5,000 payouts"
and "Republicans balk at president's stimulus-check promise" have almost no
words in common but are the same story.

The model is loaded lazily and cached: import time stays cheap, and the ~6s
first load is paid on the first ingest rather than at server startup.
"""

from __future__ import annotations

import importlib.util
import logging

import numpy as np

from ..config import settings
from .agglomerative import group_by_cosine
from .base import Document

log = logging.getLogger("newsprism.clustering.embedding")

_model = None


def _load_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        log.info("loading embedding model %s on CPU", settings.embedding_model)
        # device="cpu" is explicit: this machine has no NVIDIA GPU and we never
        # want a silent CUDA path to be attempted.
        _model = SentenceTransformer(settings.embedding_model, device="cpu")
    return _model


class EmbeddingClusterer:
    name = "embedding:all-MiniLM-L6-v2"

    def __init__(self, similarity_threshold: float | None = None) -> None:
        # Probe importability at construction time, not at first encode, so the
        # factory in __init__.py can fall back to TF-IDF before any request is
        # served rather than blowing up mid-ingest.
        if importlib.util.find_spec("sentence_transformers") is None:
            raise ImportError("sentence_transformers is not installed")
        self.similarity_threshold = (
            settings.similarity_threshold
            if similarity_threshold is None
            else similarity_threshold
        )
        self.name = f"embedding:{settings.embedding_model.split('/')[-1]}"

    def vectors(self, documents: list[Document]) -> np.ndarray:
        if not documents:
            return np.zeros((0, 384), dtype=np.float32)
        model = _load_model()
        embeddings = model.encode(
            [doc.text for doc in documents],
            batch_size=32,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return np.asarray(embeddings, dtype=np.float32)

    def cluster(self, documents: list[Document]) -> list[list[str]]:
        if not documents:
            return []
        vectors = self.vectors(documents)
        return group_by_cosine(
            [doc.id for doc in documents], vectors, self.similarity_threshold
        )
