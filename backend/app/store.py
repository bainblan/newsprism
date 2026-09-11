"""Data access. All SQL lives here; routes and pipeline speak in dicts.

The API's coverage rules are enforced in this module rather than in the route,
because they are invariants of the data, not of the transport:

* ``coverage`` is built from :func:`empty_coverage`, so all five keys always
  exist even when a lean has no articles.
* Counts are tallied from the cluster's own articles, so
  ``sum(coverage.values()) == article_count`` holds by construction rather
  than by convention.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterable

from .db import connect
from .outlets import LEANS, empty_coverage
from .rss import Article
from .timeutil import now_iso_z, to_iso_z, utcnow

_VALID_LEANS = set(LEANS)


def upsert_articles(articles: Iterable[Article]) -> tuple[int, int]:
    """Insert articles, ignoring ones already stored.

    Returns ``(seen, newly_inserted)``. Dedup is by URL at the database level
    too, not only in memory, so re-running ingest cannot duplicate a story.
    """
    seen = 0
    new = 0
    first_seen = now_iso_z()
    with connect() as conn:
        for article in articles:
            seen += 1
            cursor = conn.execute(
                """
                INSERT INTO articles
                    (id, url, outlet, lean, title, summary, published_at, first_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO NOTHING
                """,
                (
                    article.id,
                    article.url,
                    article.outlet,
                    article.lean,
                    article.title,
                    article.summary,
                    article.published_at,
                    first_seen,
                ),
            )
            if cursor.rowcount:
                new += 1
    return seen, new


def articles_for_clustering(window_days: int) -> list[dict[str, Any]]:
    """Articles recent enough to be clustered together.

    A window matters for quality as well as speed: month-old articles about a
    recurring topic will happily cluster with today's, producing a "story" that
    is really a subject.
    """
    with connect() as conn:
        if window_days <= 0:
            rows = conn.execute(
                "SELECT id, url, outlet, lean, title, summary, published_at FROM articles"
            ).fetchall()
        else:
            # Compared as a string, not via SQLite's datetime(): published_at is
            # stored in the contract's fixed-width "...T...Z" form, which sorts
            # lexicographically but does NOT match datetime()'s space-separated
            # output.
            cutoff = to_iso_z(utcnow() - timedelta(days=int(window_days)))
            rows = conn.execute(
                """
                SELECT id, url, outlet, lean, title, summary, published_at
                FROM articles
                WHERE published_at >= ?
                """,
                (cutoff,),
            ).fetchall()
    return [dict(row) for row in rows]


def replace_clusters(clusters: list[dict[str, Any]]) -> int:
    """Rewrite the derived cluster tables wholesale.

    Clusters are recomputed from scratch on every ingest because incremental
    assignment drifts: an article assigned to a cluster on Monday may belong
    elsewhere once Tuesday's coverage arrives.
    """
    formed_at = now_iso_z()
    with connect() as conn:
        conn.execute("DELETE FROM clusters")
        conn.execute("UPDATE articles SET cluster_id = NULL")
        for cluster in clusters:
            conn.execute(
                """
                INSERT INTO clusters (id, title, summary, updated_at, article_count, formed_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    cluster["id"],
                    cluster["title"],
                    cluster["summary"],
                    cluster["updated_at"],
                    len(cluster["article_ids"]),
                    formed_at,
                ),
            )
            conn.executemany(
                "UPDATE articles SET cluster_id = ? WHERE id = ?",
                [(cluster["id"], article_id) for article_id in cluster["article_ids"]],
            )
    return len(clusters)


def get_stories(limit: int, min_sources: int) -> list[dict[str, Any]]:
    """Clusters newest first, with every member article attached.

    ``sources`` carries the whole cluster so the frontend can render a detail
    view without a second request, per the contract.
    """
    with connect() as conn:
        cluster_rows = conn.execute(
            """
            SELECT id, title, summary, updated_at, article_count
            FROM clusters
            WHERE article_count >= ?
            ORDER BY updated_at DESC, id ASC
            LIMIT ?
            """,
            (min_sources, limit),
        ).fetchall()

        stories: list[dict[str, Any]] = []
        for cluster in cluster_rows:
            article_rows = conn.execute(
                """
                SELECT outlet, lean, title, url, published_at
                FROM articles
                WHERE cluster_id = ?
                ORDER BY published_at DESC, outlet ASC
                """,
                (cluster["id"],),
            ).fetchall()

            coverage = empty_coverage()
            sources = []
            for article in article_rows:
                lean = article["lean"]
                # An unknown lean would silently break the
                # sum(coverage) == article_count guarantee, so it is bucketed
                # into "center" rather than dropped. The registry is a closed
                # enum, so this is defence in depth, not an expected path.
                if lean not in _VALID_LEANS:
                    lean = "center"
                coverage[lean] += 1
                sources.append(
                    {
                        "outlet": article["outlet"],
                        "lean": lean,
                        "title": article["title"],
                        "url": article["url"],
                        "published_at": article["published_at"],
                    }
                )

            stories.append(
                {
                    "id": cluster["id"],
                    "title": cluster["title"],
                    "summary": cluster["summary"],
                    "updated_at": cluster["updated_at"],
                    # Derived from the attached articles, never from the stored
                    # counter, so the contract's sum invariant cannot drift.
                    "article_count": len(sources),
                    "coverage": coverage,
                    "sources": sources,
                }
            )

    return stories
