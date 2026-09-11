"""API routes. Shapes here are dictated by docs/api-contract.md.

Query parameters are declared as bare ``int`` with no ge/le on purpose. The
contract distinguishes two failure modes that FastAPI would otherwise collapse
into one 422:

* out of range  -> clamp silently (limit=5000 means limit=100)
* unparseable   -> 422 INVALID_PARAM (limit=abc)

Declaring ge/le would turn the first case into the second and break a frontend
that was told out-of-range is safe.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query

from . import store
from .db import article_count, init_db
from .errors import internal, no_data
from .outlets import OUTLETS
from .pipeline import mark_ingest_time, run_ingest
from .schemas import (
    ErrorResponse,
    IngestResponse,
    OutletsResponse,
    StoriesResponse,
)
from .timeutil import now_iso_z

log = logging.getLogger("newsprism.routes")

router = APIRouter(prefix="/api")

LIMIT_MIN, LIMIT_MAX = 1, 100
MIN_SOURCES_MIN, MIN_SOURCES_MAX = 1, 100

ERROR_RESPONSES = {
    422: {"model": ErrorResponse, "description": "INVALID_PARAM"},
    500: {"model": ErrorResponse, "description": "INTERNAL"},
    503: {"model": ErrorResponse, "description": "NO_DATA"},
}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


@router.get("/stories", response_model=StoriesResponse, responses=ERROR_RESPONSES)
def list_stories(
    limit: int = Query(20, description="1-100. Out of range is clamped, not an error."),
    min_sources: int = Query(
        2, description="Clusters with fewer articles are omitted."
    ),
) -> StoriesResponse:
    limit = _clamp(limit, LIMIT_MIN, LIMIT_MAX)
    min_sources = _clamp(min_sources, MIN_SOURCES_MIN, MIN_SOURCES_MAX)

    try:
        init_db()
        total_articles = article_count()
    except Exception:
        log.exception("stories: database unavailable")
        raise internal("Could not read the story database.") from None

    if total_articles == 0:
        # Distinct from "no cluster matched your filter": the database has
        # never been populated at all, which the contract makes a first-class
        # empty state with a "Run ingest" affordance.
        raise no_data(
            "No articles have been ingested yet. Run POST /api/ingest to populate "
            "the database."
        )

    try:
        stories = store.get_stories(limit=limit, min_sources=min_sources)
    except Exception:
        log.exception("stories: query failed")
        raise internal("Could not assemble the story list.") from None

    # An empty list here is valid and not an error: articles exist, but no
    # cluster reached min_sources.
    return StoriesResponse(generated_at=now_iso_z(), stories=stories)


@router.post("/ingest", response_model=IngestResponse, responses=ERROR_RESPONSES)
def ingest() -> IngestResponse:
    try:
        result = run_ingest()
    except Exception:
        log.exception("ingest: run failed")
        raise internal("The ingest run failed.") from None

    if result["feeds_succeeded"] == 0:
        # Partial failure is success, per the contract - but total failure
        # leaves nothing to show, so it reports as NO_DATA rather than as a
        # 200 that claims a successful run.
        raise no_data(
            f"All {result['feeds_attempted']} feeds failed; nothing was ingested."
        )

    try:
        mark_ingest_time()
    except Exception:  # noqa: BLE001 - bookkeeping only, never fail the run
        log.warning("ingest: could not record last-ingest timestamp", exc_info=True)

    return IngestResponse(**result)


@router.get("/outlets", response_model=OutletsResponse, responses=ERROR_RESPONSES)
def list_outlets() -> OutletsResponse:
    return OutletsResponse(
        outlets=[
            {
                "name": outlet.name,
                "lean": outlet.lean,
                "feed_url": outlet.feed_url,
                "active": outlet.active,
            }
            for outlet in OUTLETS
        ]
    )
