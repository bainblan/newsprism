"""The single error envelope every non-2xx response uses.

Contract (docs/api-contract.md):

    { "error": { "code": "NO_DATA", "message": "Human-readable explanation." } }

There are no exceptions to this shape, which means every path that can produce
a non-2xx has to go through here — including FastAPI's own validation errors
and any unhandled exception, both of which have their own default bodies and
must be reshaped in main.py.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


class ApiError(HTTPException):
    """Raise this instead of HTTPException so the envelope is never bypassed."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message},
            headers=headers,
        )
        self.code = code
        self.message = message


def envelope(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def invalid_param(message: str) -> ApiError:
    return ApiError(422, "INVALID_PARAM", message)


def no_data(message: str) -> ApiError:
    return ApiError(503, "NO_DATA", message)


def not_found(message: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def unauthorized(message: str) -> ApiError:
    return ApiError(401, "UNAUTHORIZED", message)


def ingest_in_progress(message: str) -> ApiError:
    return ApiError(409, "INGEST_IN_PROGRESS", message)


def ingest_cooldown(message: str, retry_after: int) -> ApiError:
    return ApiError(
        429, "INGEST_COOLDOWN", message, headers={"Retry-After": str(retry_after)}
    )


def internal(message: str = "An unexpected internal error occurred.") -> ApiError:
    # Never pass exception text in here: the contract forbids leaking traces.
    return ApiError(500, "INTERNAL", message)
