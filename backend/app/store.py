"""Data access. All SQL lives here; routes and pipeline speak in dicts.

The API's coverage rules are enforced in this module rather than in the route,
because they are invariants of the data, not of the transport:

* ``coverage`` is built from :func:`empty_coverage`, so all five keys always
  exist even when a lean has no articles.
* Counts are tallied from the story's own articles, so
  ``sum(coverage.values()) == article_count`` holds by construction rather
  than by convention.

Story identity (v1.1) is handled by ``app/tracking.py``, which is pure and
DB-free; this module is where its results get persisted. See that module's
docstring for the matching algorithm and ``docs/api-contract.md``'s "ID
stability" section for the guarantees it exists to satisfy.
"""

from __future__ import annotations

import sqlite3
from datetime import timedelta
from typing import Any, Iterable

from . import tracking
from .config import settings
from .db import connect
from .outlets import LEANS, empty_coverage
from .rss import Article
from .timeutil import now_iso_z, to_iso_z, utcnow

_VALID_LEANS = set(LEANS)
_MAX_ALIAS_DEPTH = 25


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


def track_and_persist_stories(
    groups: list[dict[str, Any]], window_ids: set[str]
) -> list[str]:
    """Match this run's clustering groups to durable stories and persist.

    ``groups`` is ``[{"article_ids": [...], "title": ..., "summary": ...},
    ...]`` — one entry per anonymous group the clusterer produced this run,
    already carrying its medoid representative (see ``pipeline._pick_representative``).
    ``window_ids`` is the full set of in-window article ids for this run —
    needed here (not just at clustering time) to recompute every story's
    ``archived`` flag afterward, including stories this run never touched.

    Returns the final story id for each group, in the same order as
    ``groups``, for callers that want it (none currently do, but it keeps
    this function's contract self-contained rather than write-only).
    """
    now = now_iso_z()
    with connect() as conn:
        existing = _existing_stories_with_window_membership(conn, window_ids)
        result = tracking.match_groups_to_stories(
            [g["article_ids"] for g in groups],
            existing,
            settings.id_containment_threshold,
        )

        # Phase 1: retirements. A merge loser's full stored membership (not
        # just its in-window slice) moves to the survivor, so no coverage
        # history is lost when two stories turn out to be one. The loser's
        # own story row is then deleted entirely; only the alias remains, so
        # a direct lookup by the retired id is forced through the alias
        # chain instead of returning stale data.
        for loser_id, survivor_id in result.retired_into.items():
            _retire_story(conn, loser_id, survivor_id, now)

        # Phase 2: reconcile membership for every group against its final
        # story id. An article's prior-story mapping is re-read per group
        # (after phase 1's migrations) so a moved article's old row is
        # deleted exactly once and correctly, whether it moved because of a
        # split, a shrink, or a fresh assignment.
        for group, story_id in zip(groups, result.group_story_ids):
            _assign_group(conn, story_id, group, now)

        # Final pass, one code path for every story regardless of whether it
        # was touched this run: updated_at and archived are always derived
        # from the full stored membership / current window, never carried
        # forward piecemeal.
        conn.execute(
            """
            UPDATE stories
            SET updated_at = COALESCE(
                (SELECT MAX(a.published_at)
                 FROM story_articles sa JOIN articles a ON a.id = sa.article_id
                 WHERE sa.story_id = stories.id),
                updated_at
            )
            """
        )
        if window_ids:
            placeholders = ",".join("?" for _ in window_ids)
            conn.execute(
                f"""
                UPDATE stories
                SET archived = CASE WHEN EXISTS (
                    SELECT 1 FROM story_articles sa
                    WHERE sa.story_id = stories.id AND sa.article_id IN ({placeholders})
                ) THEN 0 ELSE 1 END
                """,
                tuple(window_ids),
            )
        else:
            # No in-window articles at all this run (e.g. a cold start with
            # no feeds succeeding): nothing can be live, so every story is
            # archived. Time only moves forward, so this can never wrongly
            # un-archive a story later — see tracking.py's candidate rule.
            conn.execute("UPDATE stories SET archived = 1")

    return result.group_story_ids


def _existing_stories_with_window_membership(
    conn: sqlite3.Connection, window_ids: set[str]
) -> list[tracking.ExistingStory]:
    story_rows = conn.execute("SELECT id, first_seen_at FROM stories").fetchall()
    window_members: dict[str, set[str]] = {row["id"]: set() for row in story_rows}
    if window_ids:
        placeholders = ",".join("?" for _ in window_ids)
        member_rows = conn.execute(
            f"SELECT story_id, article_id FROM story_articles "
            f"WHERE article_id IN ({placeholders})",
            tuple(window_ids),
        ).fetchall()
        for row in member_rows:
            window_members.setdefault(row["story_id"], set()).add(row["article_id"])

    return [
        tracking.ExistingStory(
            id=row["id"],
            window_members=frozenset(window_members.get(row["id"], ())),
            first_seen_at=row["first_seen_at"],
        )
        for row in story_rows
    ]


def _retire_story(
    conn: sqlite3.Connection, loser_id: str, survivor_id: str, now: str
) -> None:
    member_rows = conn.execute(
        "SELECT article_id, added_at FROM story_articles WHERE story_id = ?",
        (loser_id,),
    ).fetchall()
    for row in member_rows:
        conn.execute(
            """
            INSERT INTO story_articles (story_id, article_id, added_at)
            VALUES (?, ?, ?)
            ON CONFLICT(story_id, article_id) DO NOTHING
            """,
            (survivor_id, row["article_id"], row["added_at"]),
        )
    conn.execute("DELETE FROM story_articles WHERE story_id = ?", (loser_id,))
    conn.execute("DELETE FROM stories WHERE id = ?", (loser_id,))

    # Flatten alias chains: anything that pointed at the id we are retiring
    # now points at its survivor, so a lookup never has to hop more than
    # necessary and a cycle cannot form.
    conn.execute(
        "UPDATE story_aliases SET story_id = ? WHERE story_id = ?",
        (survivor_id, loser_id),
    )
    conn.execute(
        """
        INSERT INTO story_aliases (alias_id, story_id, retired_at)
        VALUES (?, ?, ?)
        ON CONFLICT(alias_id) DO UPDATE SET story_id = excluded.story_id,
                                             retired_at = excluded.retired_at
        """,
        (loser_id, survivor_id, now),
    )


def _assign_group(
    conn: sqlite3.Connection, story_id: str, group: dict[str, Any], now: str
) -> None:
    article_ids = group["article_ids"]

    exists = conn.execute(
        "SELECT 1 FROM stories WHERE id = ?", (story_id,)
    ).fetchone()
    if exists:
        conn.execute(
            """
            UPDATE stories
            SET title = ?, summary = ?, last_seen_at = ?, archived = 0
            WHERE id = ?
            """,
            (group["title"], group["summary"], now, story_id),
        )
    else:
        conn.execute(
            """
            INSERT INTO stories
                (id, title, summary, updated_at, first_seen_at, last_seen_at, archived)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            """,
            (story_id, group["title"], group["summary"], now, now, now),
        )

    if not article_ids:
        return

    placeholders = ",".join("?" for _ in article_ids)
    prior_rows = conn.execute(
        f"SELECT story_id, article_id FROM story_articles WHERE article_id IN ({placeholders})",
        tuple(article_ids),
    ).fetchall()
    prior_story_of = {row["article_id"]: row["story_id"] for row in prior_rows}

    for article_id in article_ids:
        prior = prior_story_of.get(article_id)
        if prior == story_id:
            continue  # already correctly a member; keep its original added_at
        if prior is not None:
            conn.execute(
                "DELETE FROM story_articles WHERE story_id = ? AND article_id = ?",
                (prior, article_id),
            )
        conn.execute(
            """
            INSERT INTO story_articles (story_id, article_id, added_at)
            VALUES (?, ?, ?)
            ON CONFLICT(story_id, article_id) DO NOTHING
            """,
            (story_id, article_id, now),
        )


def resolve_story_id(conn: sqlite3.Connection, story_id: str) -> str | None:
    """Resolve a possibly-retired id to its canonical, currently-live story id.

    Depth-capped with a visited set so a (should-be-impossible, since alias
    creation flattens chains) cycle cannot hang a request. Returns ``None``
    if ``story_id`` names neither a live story nor a known alias.
    """
    visited: set[str] = set()
    current = story_id
    for _ in range(_MAX_ALIAS_DEPTH):
        if current in visited:
            return None
        visited.add(current)

        if conn.execute("SELECT 1 FROM stories WHERE id = ?", (current,)).fetchone():
            return current

        alias_row = conn.execute(
            "SELECT story_id FROM story_aliases WHERE alias_id = ?", (current,)
        ).fetchone()
        if not alias_row:
            return None
        current = alias_row["story_id"]

    return None


def _row_to_story(conn: sqlite3.Connection, story_row: sqlite3.Row) -> dict[str, Any]:
    article_rows = conn.execute(
        """
        SELECT a.outlet, a.lean, a.title, a.url, a.published_at
        FROM story_articles sa JOIN articles a ON a.id = sa.article_id
        WHERE sa.story_id = ?
        ORDER BY a.published_at DESC, a.outlet ASC
        """,
        (story_row["id"],),
    ).fetchall()

    coverage = empty_coverage()
    sources = []
    for article in article_rows:
        lean = article["lean"]
        # An unknown lean would silently break the sum(coverage) ==
        # article_count guarantee, so it is bucketed into "center" rather
        # than dropped. The registry is a closed enum, so this is defence in
        # depth, not an expected path.
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

    return {
        "id": story_row["id"],
        "title": story_row["title"],
        "summary": story_row["summary"],
        "updated_at": story_row["updated_at"],
        "archived": bool(story_row["archived"]),
        # Derived from the attached articles, never from a stored counter, so
        # the contract's sum invariant cannot drift.
        "article_count": len(sources),
        "coverage": coverage,
        "sources": sources,
    }


def get_stories(limit: int, min_sources: int) -> list[dict[str, Any]]:
    """Live (non-archived) stories newest first, with every member attached.

    ``sources`` carries the whole story's full stored membership — live and
    aged-out members alike — so the frontend can render a detail view
    without a second request, per the contract. ``archived`` is always
    ``false`` here: the list only ever returns stories inside the clustering
    window.
    """
    with connect() as conn:
        story_rows = conn.execute(
            """
            SELECT s.id, s.title, s.summary, s.updated_at, s.archived
            FROM stories s
            WHERE s.archived = 0
              AND (SELECT COUNT(*) FROM story_articles sa WHERE sa.story_id = s.id) >= ?
            ORDER BY s.updated_at DESC, s.id ASC
            LIMIT ?
            """,
            (min_sources, limit),
        ).fetchall()

        return [_row_to_story(conn, row) for row in story_rows]


def get_story_by_id(story_id: str) -> dict[str, Any] | None:
    """A single story by id or retired alias, resolved transparently.

    Unlike :func:`get_stories`, this is not filtered by ``min_sources`` or
    ``limit`` and may return an archived story — a direct link is a request
    for a specific thing, not a browsing decision. Returns ``None`` when
    ``story_id`` names neither a live story nor a known alias, which the
    route layer turns into 404 ``NOT_FOUND``.
    """
    with connect() as conn:
        canonical_id = resolve_story_id(conn, story_id)
        if canonical_id is None:
            return None
        story_row = conn.execute(
            "SELECT id, title, summary, updated_at, archived FROM stories WHERE id = ?",
            (canonical_id,),
        ).fetchone()
        if story_row is None:
            return None
        return _row_to_story(conn, story_row)
