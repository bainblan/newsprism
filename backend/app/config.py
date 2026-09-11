"""Runtime configuration, read from the environment with sane defaults.

Nothing here is a secret (slice 1 has no API keys), but configuration still
lives in env vars so the values can change without a code edit.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _env_str(key: str, default: str) -> str:
    value = os.environ.get(key, "").strip()
    return value or default


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env_str(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(_env_str(key, str(default)))
    except ValueError:
        return default


def _env_list(key: str, default: list[str]) -> list[str]:
    raw = _env_str(key, "")
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _resolve_db_path() -> Path:
    raw = Path(_env_str("NEWSPRISM_DB_PATH", "data/newsprism.db"))
    return raw if raw.is_absolute() else (BACKEND_ROOT / raw).resolve()


@dataclass(frozen=True)
class Settings:
    db_path: Path = field(default_factory=_resolve_db_path)
    clusterer: str = field(
        default_factory=lambda: _env_str("NEWSPRISM_CLUSTERER", "onnx")
    )
    similarity_threshold: float = field(
        default_factory=lambda: _env_float("NEWSPRISM_SIMILARITY_THRESHOLD", 0.62)
    )
    embedding_model: str = field(
        default_factory=lambda: _env_str(
            "NEWSPRISM_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        )
    )
    cluster_window_days: int = field(
        default_factory=lambda: _env_int("NEWSPRISM_CLUSTER_WINDOW_DAYS", 4)
    )
    id_containment_threshold: float = field(
        default_factory=lambda: _env_float("NEWSPRISM_ID_CONTAINMENT_THRESHOLD", 0.5)
    )
    feed_timeout_seconds: float = field(
        default_factory=lambda: _env_float("NEWSPRISM_FEED_TIMEOUT_SECONDS", 15.0)
    )
    feed_retries: int = field(
        default_factory=lambda: _env_int("NEWSPRISM_FEED_RETRIES", 2)
    )
    cors_origins: list[str] = field(
        default_factory=lambda: _env_list(
            "NEWSPRISM_CORS_ORIGINS",
            ["http://localhost:3000", "http://127.0.0.1:3000"],
        )
    )


settings = Settings()
