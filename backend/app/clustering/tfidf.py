"""Fallback clusterer: scikit-learn TF-IDF + cosine, no torch required.

Kept as a first-class implementation rather than dead code for two reasons:
it proves the seam in base.py is real, and it keeps the endpoints working on
any machine where torch or sentence-transformers will not install (ML wheels
lag new Python releases).

It is genuinely worse. TF-IDF matches words, not meaning, so two outlets
describing the same event in different language will not group. Its default
threshold is therefore much lower than the embedding clusterer's - raw lexical
overlap between two independently written headlines is small even when they are
about the same thing.
"""

from __future__ import annotations

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

from .agglomerative import group_by_cosine
from .base import Document

#: Lexical overlap runs much lower than semantic similarity, so this is not the
#: same number as the embedding clusterer's threshold and should not track it.
DEFAULT_TFIDF_THRESHOLD = 0.30


class TfidfClusterer:
    name = "tfidf"

    def __init__(self, similarity_threshold: float | None = None) -> None:
        self.similarity_threshold = (
            DEFAULT_TFIDF_THRESHOLD
            if similarity_threshold is None
            else similarity_threshold
        )

    def vectors(self, documents: list[Document]) -> np.ndarray:
        if not documents:
            return np.zeros((0, 1), dtype=np.float32)
        vectorizer = TfidfVectorizer(
            lowercase=True,
            stop_words="english",
            ngram_range=(1, 2),
            min_df=1,
            sublinear_tf=True,
            strip_accents="unicode",
        )
        matrix = vectorizer.fit_transform([doc.text for doc in documents])
        # TfidfVectorizer already L2-normalizes rows, which group_by_cosine
        # relies on. Densify: a few hundred headlines is a small matrix, and
        # AgglomerativeClustering needs dense input anyway.
        return np.asarray(matrix.todense(), dtype=np.float32)

    def cluster(self, documents: list[Document]) -> list[list[str]]:
        if not documents:
            return []
        vectors = self.vectors(documents)
        return group_by_cosine(
            [doc.id for doc in documents], vectors, self.similarity_threshold
        )
