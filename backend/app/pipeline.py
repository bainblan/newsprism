"""The ingest run: fetch -> dedupe -> persist -> cluster -> persist clusters.

Synchronous by design for slice 1, per the contract. It takes tens of seconds
and POST /api/ingest blocks on it.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import numpy as np

from .clustering import Document, TfidfClusterer, get_clusterer
from .config import settings
from .db import init_db
from .outlets import active_outlets
from .rss import dedupe, fetch_all
from .store import articles_for_clustering, replace_clusters, upsert_articles
from .timeutil import now_iso_z

log = logging.getLogger("newsprism.pipeline")

LAST_INGEST_KEY = "last_ingest_at"


def cluster_id(article_ids: list[str]) -> str:
    """Stable, opaque id derived from cluster membership.

    Same members in, same id out, so a story keeps its identity across ingest
    runs that do not change its composition. The contract says the frontend
    must not parse ids, and nothing here invites it to.
    """
    digest = hashlib.sha1("|".join(sorted(article_ids)).encode("utf-8")).hexdigest()
    return "c_" + digest[:12]


def _pick_representative(
    members: list[dict[str, Any]], vectors: np.ndarray
) -> dict[str, Any]:
    """The medoid: the article closest to the cluster's centroid.

    Not "the first one" and not "the most centrist outlet". The medoid is the
    most typical phrasing of the event, which is what a cluster headline should
    be. Picking by outlet would quietly editorialize, which is exactly what this
    product is supposed to expose rather than commit.
    """
    if len(members) == 1 or vectors.size == 0:
        return members[0]
    centroid = vectors.mean(axis=0)
    norm = np.linalg.norm(centroid)
    if norm == 0:
        return members[0]
    scores = vectors @ (centroid / norm)
    return members[int(np.argmax(scores))]


def run_ingest() -> dict[str, Any]:
    """Execute a full run and return the POST /api/ingest payload."""
    started = time.perf_counter()
    init_db()

    outlets = active_outlets()
    results = fetch_all(outlets)

    feeds_attempted = len(results)
    succeeded = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]

    for result in failed:
        log.warning(
            "feed failed: %s (%s) -> %s",
            result.outlet.name,
            result.outlet.feed_url,
            result.error,
        )

    articles = dedupe(results)
    articles_ingested, articles_new = upsert_articles(articles)

    clusters_formed = 0
    if succeeded:
        clusters_formed = recluster()

    return {
        "feeds_attempted": feeds_attempted,
        "feeds_succeeded": len(succeeded),
        # The contract's example lists URLs, so URLs is what goes on the wire.
        # Outlet names and error text go to the log, where they do not change
        # the response shape the frontend was built against.
        "feeds_failed": [r.outlet.feed_url for r in failed],
        "articles_ingested": articles_ingested,
        "articles_new": articles_new,
        "clusters_formed": clusters_formed,
        "duration_seconds": round(time.perf_counter() - started, 2),
    }


def recluster() -> int:
    """Recompute all clusters from the stored articles in the recency window.

    Returns the number of *multi-article* clusters, which is what
    ``clusters_formed`` reports: a singleton is not a story with spread, and
    counting them would make the number track the article count instead of
    saying anything about clustering.
    """
    rows = articles_for_clustering(settings.cluster_window_days)
    if not rows:
        replace_clusters([])
        return 0

    documents = [
        Document(id=row["id"], title=row["title"], summary=row["summary"] or "")
        for row in rows
    ]
    by_id = {row["id"]: row for row in rows}

    clusterer = get_clusterer()
    try:
        vectors = clusterer.vectors(documents)
        groups = clusterer.cluster(documents)
    except Exception as exc:  # noqa: BLE001
        # Embedding can fail at first use even when the package imports (model
        # download blocked, corrupt cache). Degrading to TF-IDF keeps the
        # endpoints answering instead of turning every ingest into a 500.
        log.error("clusterer %s failed (%s); retrying with TF-IDF", clusterer.name, exc)
        clusterer = TfidfClusterer()
        vectors = clusterer.vectors(documents)
        groups = clusterer.cluster(documents)

    index_of = {doc.id: i for i, doc in enumerate(documents)}

    clusters: list[dict[str, Any]] = []
    multi = 0
    for group in groups:
        members = [by_id[article_id] for article_id in group]
        member_vectors = (
            vectors[[index_of[article_id] for article_id in group]]
            if vectors.size
            else np.zeros((0, 1), dtype=np.float32)
        )
        representative = _pick_representative(members, member_vectors)
        clusters.append(
            {
                "id": cluster_id(group),
                "title": representative["title"],
                "summary": representative["summary"] or "",
                # Newest member wins: a story's updated_at is when it last got
                # new coverage.
                "updated_at": max(m["published_at"] for m in members),
                "article_ids": group,
            }
        )
        if len(group) > 1:
            multi += 1

    replace_clusters(clusters)
    log.info(
        "clustered %d articles into %d clusters (%d multi-source) using %s",
        len(documents),
        len(clusters),
        multi,
        clusterer.name,
    )
    return multi


def mark_ingest_time() -> None:
    from .db import set_meta

    set_meta(LAST_INGEST_KEY, now_iso_z())
