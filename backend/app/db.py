"""SQLite persistence.

Two tables and a key/value meta table. Articles are the durable record;
clusters are derived and rewritten wholesale on every ingest run, so the
cluster tables are safe to drop and rebuild at any time.

sqlite3 connections are not shareable across threads, so a connection is
opened per unit of work rather than held on the app.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,
    outlet        TEXT NOT NULL,
    lean          TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    cluster_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cluster   ON articles (cluster_id);

CREATE TABLE IF NOT EXISTS clusters (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL,
    article_count INTEGER NOT NULL,
    formed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters (updated_at DESC);

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


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


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
