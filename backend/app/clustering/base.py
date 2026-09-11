"""The clustering seam.

Clustering is the part of newsprism most likely to be replaced, so the rest of
the system only ever sees this interface: a list of :class:`Document` in, a
list of groups of document ids out. No implementation detail - embeddings,
vectorizers, thresholds - escapes past this boundary.

Contract for any implementation:

* Every input document id appears in exactly one output group.
* Groups are non-empty. Singletons are legitimate output; filtering by
  ``min_sources`` happens later, at query time.
* Order of groups is not meaningful.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class Document:
    id: str
    title: str
    summary: str

    @property
    def text(self) -> str:
        """What gets embedded: headline first, then the lead.

        The title carries most of the signal about *which event* this is; the
        lead disambiguates headlines that are terse or written for a pun.
        """
        summary = self.summary.strip()
        title = self.title.strip()
        if not summary:
            return title
        return f"{title}. {summary}"


@runtime_checkable
class Clusterer(Protocol):
    name: str

    def cluster(self, documents: list[Document]) -> list[list[str]]:
        """Group documents that describe the same event."""
        ...

    def vectors(self, documents: list[Document]) -> np.ndarray:
        """L2-normalized row vectors, aligned with ``documents``.

        Exposed so the pipeline can pick a cluster medoid as the representative
        article without knowing how the vectors were produced.
        """
        ...
