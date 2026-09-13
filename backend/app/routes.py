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
import secrets

from fastapi import APIRouter, Depends, Header, Query

from . import store
from .config import settings
from .db import article_count, init_db
from .errors import internal, no_data, not_found, unauthorized
from .outlets import OUTLETS
from .pipeline import mark_ingest_time, run_ingest
from .schemas import (
    ErrorResponse,
    IngestResponse,
    OutletsResponse,
    StoriesResponse,
    StoryResponse,
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

STORY_ERROR_RESPONSES = {
    **ERROR_RESPONSES,
    404: {"model": ErrorResponse, "description": "NOT_FOUND"},
}

INGEST_ERROR_RESPONSES = {
    **ERROR_RESPONSES,
    401: {"model": ErrorResponse, "description": "UNAUTHORIZED"},
}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def require_ingest_token(
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
) -> None:
    """Gate for ``POST /api/ingest`` only (contract v1.2).

    A missing header and a wrong one must be indistinguishable, so both fall
    through to the same comparison and the same error - never reveal whether
    a token is even configured. Comparing UTF-8 *bytes* rather than the raw
    ``str`` sidesteps ``secrets.compare_digest``'s refusal to compare
    non-ASCII ``str`` values (it raises ``TypeError`` on those), so a garbage
    header value produces a clean 401 rather than an unhandled 500. Any
    ``str`` encodes to UTF-8 without raising, so this is exception-free.

    Wired in as a FastAPI dependency (not a statement inside the route body)
    so a rejected request runs before, and instead of, ``run_ingest()`` -
    structurally, not just by call order.
    """
    expected = settings.ingest_token
    if not expected:
        return  # unset token = open endpoint, per the contract
    candidate = x_ingest_token or ""
    if not secrets.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8")):
        raise unauthorized("Missing or invalid X-Ingest-Token header.")


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


@router.get(
    "/stories/{story_id}", response_model=StoryResponse, responses=STORY_ERROR_RESPONSES
)
def get_story(story_id: str) -> StoryResponse:
    """Fetch one story by id or retired alias.

    ``story_id`` is a bare string with no format validation: it is opaque
    per the contract, and a regex here would risk rejecting a legitimate id
    the frontend is only ever supposed to echo back verbatim.

    ``min_sources`` and ``limit`` never apply here — a direct link is a
    request for a specific thing, not a browsing decision. Aliases resolve
    transparently: the response carries the *canonical* id, not the one in
    the URL, with no HTTP redirect.
    """
    try:
        init_db()
        total_articles = article_count()
    except Exception:
        log.exception("story lookup: database unavailable")
        raise internal("Could not read the story database.") from None

    if total_articles == 0:
        raise no_data(
            "No articles have been ingested yet. Run POST /api/ingest to populate "
            "the database."
        )

    try:
        story = store.get_story_by_id(story_id)
    except Exception:
        log.exception("story lookup: query failed")
        raise internal("Could not look up that story.") from None

    if story is None:
        raise not_found(f"No story or alias matches id '{story_id}'.")

    return StoryResponse(story=story)


@router.post(
    "/ingest",
    response_model=IngestResponse,
    responses=INGEST_ERROR_RESPONSES,
    dependencies=[Depends(require_ingest_token)],
)
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
