"""One place that decides what a timestamp looks like on the wire.

The contract says ISO 8601 UTC with a trailing Z, e.g. 2026-09-10T14:23:00Z.
Python's ``datetime.isoformat()`` emits ``+00:00``, which is *not* that string,
so every timestamp the API returns is formatted through :func:`to_iso_z`.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

ISO_Z = "%Y-%m-%dT%H:%M:%SZ"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_iso_z(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime(ISO_Z)


def now_iso_z() -> str:
    return to_iso_z(utcnow())


def from_struct_time(parsed: time.struct_time | None) -> datetime | None:
    """feedparser hands back a UTC-normalized struct_time, or None."""
    if parsed is None:
        return None
    try:
        return datetime(*parsed[:6], tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def parse_iso_z(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, ISO_Z).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
