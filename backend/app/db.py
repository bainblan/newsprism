"""SQLite persistence.

Articles are the durable record. Stories (v1.1) are also durable entities,
distinct from the derived, rewrite-every-run ``story_articles`` membership
rows that link them to articles — see ``app/tracking.py`` for how membership
and identity are kept separate on purpose.

sqlite3 connections are not shareable across threads, so a connection is
opened per unit of work rather than held on the app.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import settings

log = logging.getLogger("newsprism.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,
    outlet        TEXT NOT NULL,
    lean          TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (published_at DESC);

CREATE TABLE IF NOT EXISTS stories (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stories_updated ON stories (updated_at DESC);

CREATE TABLE IF NOT EXISTS story_articles (
    story_id   TEXT NOT NULL,
    article_id TEXT NOT NULL,
    added_at   TEXT NOT NULL,
    PRIMARY KEY (story_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_story_articles_article ON story_articles (article_id);
CREATE INDEX IF NOT EXISTS idx_story_articles_story   ON story_articles (story_id);

CREATE TABLE IF NOT EXISTS story_aliases (
    alias_id   TEXT PRIMARY KEY,
    story_id   TEXT NOT NULL,
    retired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def db_path() -> Path:
    return settings.db_path


def ensure_parent_dir() -> None:
    db_path().parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_parent_dir()
    conn = sqlite3.connect(db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate_from_v1(conn: sqlite3.Connection) -> None:
    """Drop the v1 ``clusters`` table and ``articles.cluster_id`` column.

    Both are derived data made worthless by the id-churn bug v1.1 fixes, so
    there is nothing to preserve. ``init_db`` runs on every request path, so
    this must be idempotent and cheap when there is nothing left to migrate.
    """
    tables = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if "clusters" in tables:
        conn.execute("DROP TABLE clusters")

    columns = {row["name"] for row in conn.execute("PRAGMA table_info(articles)").fetchall()}
    if "cluster_id" in columns:
        # The v1 SCHEMA indexed this column (idx_articles_cluster). SQLite
        # refuses to DROP COLUMN while an index still references it, so the
        # index has to go first - dropping the column alone is not enough.
        conn.execute("DROP INDEX IF EXISTS idx_articles_cluster")
        try:
            conn.execute("ALTER TABLE articles DROP COLUMN cluster_id")
        except sqlite3.OperationalError as exc:
            # Pre-authorized fallback: this is still reachable on SQLite
            # older than 3.35, which lacks DROP COLUMN entirely. But do not
            # assert that as the cause - log what actually happened instead
            # of guessing, since a wrong diagnosis in a log sends the next
            # person down the wrong path. Leave the column in place, inert;
            # nothing in v1.1 reads or writes it.
            log.warning(
                "articles.cluster_id could not be dropped (%s); leaving the "
                "column in place, unused.",
                exc,
            )


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        _migrate_from_v1(conn)


def article_count() -> int:
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM articles").fetchone()
        return int(row["n"])


def set_meta(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_meta(key: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
