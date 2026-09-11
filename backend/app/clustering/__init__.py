"""Clustering implementations and the factory that selects one.

Swap the algorithm by setting NEWSPRISM_CLUSTERER; nothing outside this package
changes. If the configured implementation cannot be constructed (for example
torch is not installed), the factory falls back to TF-IDF and logs loudly
rather than failing the process - a degraded cluster is more useful than a
backend that will not boot.
"""

from __future__ import annotations

import logging

from ..config import settings
from .base import Clusterer, Document
from .onnx_embedding import OnnxClusterer
from .tfidf import TfidfClusterer

log = logging.getLogger("newsprism.clustering")

__all__ = ["Clusterer", "Document", "OnnxClusterer", "TfidfClusterer", "get_clusterer"]

_cached: Clusterer | None = None


def _build(name: str) -> Clusterer:
    if name == "tfidf":
        return TfidfClusterer()
    if name == "onnx":
        return OnnxClusterer()
    if name == "embedding":
        # Reference implementation only: requires the torch/sentence-
        # transformers extra (requirements-torch.txt), not installed by
        # default. Kept importable for equivalence re-verification after a
        # future model change - see docs/onnx-migration.md.
        from .embedding import EmbeddingClusterer

        return EmbeddingClusterer()
    raise ValueError(
        f"unknown clusterer {name!r}; expected 'onnx', 'embedding', or 'tfidf'"
    )


def get_clusterer(force: str | None = None) -> Clusterer:
    global _cached
    if force is not None:
        return _build(force)
    if _cached is not None:
        return _cached
    try:
        _cached = _build(settings.clusterer)
    except Exception as exc:  # noqa: BLE001
        log.error(
            "clusterer %r unavailable (%s); falling back to TF-IDF",
            settings.clusterer,
            exc,
        )
        _cached = TfidfClusterer()
    return _cached
