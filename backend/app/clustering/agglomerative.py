"""Shared clustering step: average-linkage agglomerative over cosine distance.

Both implementations differ only in how they turn text into vectors, so the
grouping logic lives here once.

Why average linkage rather than single linkage: single linkage chains. One
article that is moderately similar to two unrelated stories is enough to merge
them, and with news headlines that happens constantly (any two articles
mentioning the same politician look alike). Average linkage requires the groups
to be similar on the whole, which is the property the product actually needs -
"same event", not "shares a proper noun".
"""

from __future__ import annotations

import numpy as np
from sklearn.cluster import AgglomerativeClustering


def group_by_cosine(
    ids: list[str], vectors: np.ndarray, similarity_threshold: float
) -> list[list[str]]:
    """Group ids whose vectors cluster within ``similarity_threshold`` cosine.

    ``vectors`` must be L2-normalized, so cosine distance is ``1 - dot``.
    """
    if not ids:
        return []
    if len(ids) == 1:
        return [[ids[0]]]

    distance_threshold = max(1e-6, 1.0 - float(similarity_threshold))
    model = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=distance_threshold,
        metric="cosine",
        linkage="average",
    )
    labels = model.fit_predict(vectors)

    groups: dict[int, list[str]] = {}
    for doc_id, label in zip(ids, labels):
        groups.setdefault(int(label), []).append(doc_id)
    return list(groups.values())
