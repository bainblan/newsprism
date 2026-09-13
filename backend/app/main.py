"""FastAPI application entry point.

Run from the backend/ directory:

    uvicorn app.main:app --reload --port 8000

The exception handlers below are the load-bearing part of this module. The
contract says *every* non-2xx uses the same envelope, and FastAPI's defaults do
not: validation errors come back as ``{"detail": [...]}`` and an unhandled
exception comes back as ``{"detail": "Internal Server Error"}`` (or an HTML
traceback). Both are reshaped here so there is no path out of the app that
produces a body the frontend was not built to read.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .clustering import get_clusterer
from .config import settings
from .db import init_db
from .errors import envelope
from .routes import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("newsprism")

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Create the schema up front so a cold clone answers 503 NO_DATA on the
    # first request instead of erroring on a missing table.
    init_db()
    log.info("database ready at %s", settings.db_path)
    # Report the clusterer's own threshold, not settings.similarity_threshold:
    # the TF-IDF fallback uses a different scale and logging the embedding
    # number next to "clusterer=tfidf" would be a lie in the logs.
    clusterer = get_clusterer()
    log.info(
        "clusterer=%s threshold=%s",
        clusterer.name,
        getattr(clusterer, "similarity_threshold", "n/a"),
    )
    log.info("CORS origins: %s", ", ".join(settings.cors_origins))
    if settings.ingest_token:
        log.info("POST /api/ingest is protected by NEWSPRISM_INGEST_TOKEN")
    else:
        log.warning(
            "NEWSPRISM_INGEST_TOKEN is unset - POST /api/ingest is UNAUTHENTICATED "
            "and open to anyone who can reach this host"
        )
    yield


app = FastAPI(
    title="newsprism API",
    version="1.0.0",
    description="Slice 1: RSS ingestion, story clustering, coverage breakdown.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(router)


@app.exception_handler(StarletteHTTPException)
def http_exception_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    """ApiError carries {code, message}; anything else gets a generic mapping.

    ``exc.headers`` (e.g. ``Retry-After`` on a 429 ``INGEST_COOLDOWN``) must be
    forwarded explicitly — ``JSONResponse`` does not inherit them from the
    exception on its own, so a header set via ``ApiError(..., headers=...)``
    would otherwise be silently dropped on the way to the wire.
    """
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        body = envelope(str(detail["code"]), str(detail["message"]))
    else:
        code = {404: "NOT_FOUND", 405: "NOT_FOUND", 422: "INVALID_PARAM"}.get(
            exc.status_code, "INTERNAL"
        )
        body = envelope(code, str(detail) if detail else "Request could not be handled.")
    return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers)


@app.exception_handler(RequestValidationError)
def validation_exception_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    """Unparseable parameters -> 422 INVALID_PARAM in the standard envelope.

    Out-of-range values never reach here; the routes clamp those. So anything
    that does arrive is genuinely unparseable.
    """
    names = []
    for error in exc.errors():
        location = error.get("loc") or ()
        if len(location) > 1:
            names.append(str(location[-1]))
    detail = ", ".join(dict.fromkeys(names)) or "request"
    return JSONResponse(
        status_code=422,
        content=envelope(
            "INVALID_PARAM", f"Could not parse parameter: {detail}."
        ),
    )


@app.exception_handler(Exception)
def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last line of defence. The trace goes to the log, never to the client."""
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content=envelope("INTERNAL", "An unexpected internal error occurred."),
    )


@app.get("/api/health", include_in_schema=False)
def health() -> dict[str, str]:
    """Additive to the contract; nothing in the frontend depends on it.

    ``ingest_protected`` is deliberately the string "true"/"false", not a
    JSON boolean - kept as ``dict[str, str]`` (unchanged from before this
    field was added) rather than widening the return type, since every other
    value here is already a plain string and the contract only asks that the
    state be externally checkable, not that it be typed as a bool.
    """
    return {
        "status": "ok",
        "clusterer": settings.clusterer,
        "ingest_protected": "true" if settings.ingest_token else "false",
    }
