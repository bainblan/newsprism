"""Response models. These are the contract, expressed in code.

Field names and nesting here must match docs/api-contract.md character for
character; a frontend agent is building against that text without seeing this
file.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .outlets import Lean


class Coverage(BaseModel):
    """Always all five keys, zero-filled. The frontend never handles a missing one."""

    left: int = 0
    lean_left: int = 0
    center: int = 0
    lean_right: int = 0
    right: int = 0


class Source(BaseModel):
    outlet: str
    lean: Lean
    title: str
    url: str
    published_at: str


class Story(BaseModel):
    id: str
    title: str
    summary: str
    updated_at: str
    archived: bool
    article_count: int
    coverage: Coverage
    sources: list[Source]


class StoriesResponse(BaseModel):
    generated_at: str
    stories: list[Story]


class StoryResponse(BaseModel):
    story: Story


class IngestResponse(BaseModel):
    feeds_attempted: int
    feeds_succeeded: int
    feeds_failed: list[str]
    articles_ingested: int
    articles_new: int
    clusters_formed: int
    duration_seconds: float


class OutletOut(BaseModel):
    name: str
    lean: Lean
    feed_url: str
    active: bool


class OutletsResponse(BaseModel):
    outlets: list[OutletOut]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    """Documented purely so /docs shows the real error shape."""

    error: ErrorBody = Field(
        examples=[{"code": "NO_DATA", "message": "Human-readable explanation."}]
    )
