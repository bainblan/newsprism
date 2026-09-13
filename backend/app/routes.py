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
import math
import secrets

from fastapi import APIRouter, Depends, Header, Query

from . import store
from .config import settings
from .db import article_count, init_db
from .errors import (
    ingest_cooldown,
    ingest_in_progress,
    internal,
    no_data,
    not_found,
    unauthorized,
)
from .outlets import OUTLETS
from .pipeline import (
    last_ingest_at,
    mark_ingest_time,
    release_ingest_lock,
    run_ingest,
    try_acquire_ingest_lock,
)
from .schemas import (
    ErrorResponse,
    IngestResponse,
    OutletsResponse,
    StoriesResponse,
    StoryResponse,
)
from .timeutil import now_iso_z, parse_iso_z, utcnow

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
    409: {"model": ErrorResponse, "description": "INGEST_IN_PROGRESS"},
    429: {"model": ErrorResponse, "description": "INGEST_COOLDOWN"},
}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def require_ingest_token(
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
) -> bool:
    """Gate for ``POST /api/ingest`` only. Narrowed meaning in contract v1.3.

    Returns whether the caller presented a *valid* token, which the route
    body uses to decide whether the cooldown applies - the lock applies
    regardless. A **missing** header is now anonymous-and-allowed (v1.2 made
    it a hard 401 when a token was configured; v1.3 reverses that, since the
    server now bounds anonymous callers itself via cooldown + lock). A
    **present but invalid** header stays a hard 401, since a broken token
    must surface as a failed `curl -f` from the cron rather than silently
    degrading to a bounded anonymous request.

    Comparing UTF-8 *bytes* rather than the raw ``str`` sidesteps
    ``secrets.compare_digest``'s refusal to compare non-ASCII ``str`` values
    (it raises ``TypeError`` on those), so a garbage header value produces a
    clean 401 rather than an unhandled 500. Any ``str`` encodes to UTF-8
    without raising, so this is exception-free.

    Wired in as a route parameter dependency (not a bare ``dependencies=``
    entry) so a rejected request still runs before, and instead of,
    ``run_ingest()`` - structurally, not just by call order - while the
    validity result is available to the route body for the cooldown check.
    """
    expected = settings.ingest_token
    if not expected:
        return False  # unset token = every caller is anonymous and bounded
    candidate = x_ingest_token or ""
    if not candidate:
        return False  # no header at all = anonymous and bounded, per v1.3
    if not secrets.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8")):
        raise unauthorized("Missing or invalid X-Ingest-Token header.")
    return True


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


def _describe_elapsed(seconds: float) -> str:
    """Plain-language "how recently" for the cooldown message.

    The contract requires this be renderable verbatim by the frontend, so it
    is prose, not a duration format.
    """
    minutes = int(seconds // 60)
    if minutes < 1:
        return "less than a minute ago"
    if minutes == 1:
        return "1 minute ago"
    return f"{minutes} minutes ago"


def _describe_wait(seconds: int) -> str:
    """Plain-language "how much longer" for the cooldown message.

    Forward-looking counterpart to ``_describe_elapsed``. The numeric
    ``Retry-After`` header stays an exact second count for machines; this is
    only the human sentence, and a bare seconds count ("in 884 seconds") is
    not something anyone says aloud - it reads as a number to do arithmetic
    on, not as information. Rounds *up* to the minute so the message never
    promises a shorter wait than actually remains.
    """
    if seconds < 60:
        return "less than a minute"
    minutes = math.ceil(seconds / 60)
    if minutes == 1:
        return "about a minute"
    return f"about {minutes} minutes"


def _check_cooldown() -> None:
    """Raise 429 INGEST_COOLDOWN if the last successful run was too recent.

    Only reached for anonymous callers - a valid token bypasses this
    entirely (see the route body). Silently proceeds if there is no
    recorded last-ingest time, or if it fails to parse: this is a
    convenience limit on top of the absolute lock below, not a safety
    property, so failing open here is the right default.
    """
    last = last_ingest_at()
    if last is None:
        return
    last_dt = parse_iso_z(last)
    if last_dt is None:
        return
    elapsed = (utcnow() - last_dt).total_seconds()
    remaining = settings.ingest_cooldown_seconds - elapsed
    if remaining <= 0:
        return
    retry_after = max(1, math.ceil(remaining))
    raise ingest_cooldown(
        f"The last ingest run finished {_describe_elapsed(elapsed)}. "
        f"Please try again in {_describe_wait(retry_after)}.",
        retry_after,
    )


@router.post(
    "/ingest",
    response_model=IngestResponse,
    responses=INGEST_ERROR_RESPONSES,
)
def ingest(token_is_valid: bool = Depends(require_ingest_token)) -> IngestResponse:
    """Enforced in this exact order (contract v1.3):

    1. Invalid token -> 401, via the ``require_ingest_token`` dependency,
       which runs before this body at all - always first, regardless of
       cooldown or lock state.
    2. Cooldown -> 429, skipped entirely when the caller presented a valid
       token. This is policy: a token buys permission to ask more often.
    3. Single-flight lock -> 409, for *every* caller including a valid
       token. This is physics: two concurrent runs OOM the host, and no
       amount of authorization changes that.
    """
    if not token_is_valid:
        _check_cooldown()

    if not try_acquire_ingest_lock():
        raise ingest_in_progress(
            "An ingest run is already in progress. Please wait for it to finish."
        )

    try:
        try:
            result = run_ingest()
        except Exception:
            log.exception("ingest: run failed")
            raise internal("The ingest run failed.") from None

        if result["feeds_succeeded"] == 0:
            # Partial failure is success, per the contract - but total
            # failure leaves nothing to show, so it reports as NO_DATA
            # rather than as a 200 that claims a successful run.
            raise no_data(
                f"All {result['feeds_attempted']} feeds failed; nothing was ingested."
            )

        try:
            mark_ingest_time()
        except Exception:  # noqa: BLE001 - bookkeeping only, never fail the run
            log.warning("ingest: could not record last-ingest timestamp", exc_info=True)

        return IngestResponse(**result)
    finally:
        # Every exit path - success, the internal-error re-raise, and the
        # total-feed-failure 503 - must release the lock. A leaked lock
        # wedges POST /api/ingest until the process restarts, which is a
        # worse outage than the one this lock exists to prevent.
        release_ingest_lock()


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
