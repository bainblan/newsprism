"""Outlet registry — ARCHITECT-OWNED.

The bias labels below are an editorial judgment, not an engineering one. They
are transcribed verbatim from docs/api-contract.md. Do not add, remove, or
re-label an outlet here without the Architect changing the contract first.

Feed URLs are also transcribed verbatim. Verification results as of
2026-09-10 are recorded in the `note` field where a feed did not work; a
broken feed is left in place and surfaced in POST /api/ingest's `feeds_failed`
rather than quietly removed, because a silently missing outlet is a product
bug for a product whose whole claim is balanced coverage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

Lean = Literal["left", "lean_left", "center", "lean_right", "right"]

#: The closed enum, in spectrum order. Every ``coverage`` object emitted by the
#: API contains exactly these keys, zero-filled.
LEANS: tuple[Lean, ...] = get_args(Lean)


@dataclass(frozen=True)
class Outlet:
    name: str
    lean: Lean
    feed_url: str
    active: bool = True
    note: str | None = None


OUTLETS: tuple[Outlet, ...] = (
    Outlet(
        "HuffPost",
        "left",
        "https://www.huffpost.com/section/front-page/feed",
        note=(
            "Verified 2026-09-10: HTTP 200 but the feed body contains zero "
            "<item> elements, so no articles can be ingested. "
            "https://www.huffpost.com/section/politics/feed returns 50 items "
            "and is a tested replacement candidate — Architect's call."
        ),
    ),
    Outlet("Vox", "left", "https://www.vox.com/rss/index.xml"),
    Outlet("The Guardian (US)", "lean_left", "https://www.theguardian.com/us-news/rss"),
    Outlet("NPR", "lean_left", "https://feeds.npr.org/1001/rss.xml"),
    Outlet("CNN", "lean_left", "http://rss.cnn.com/rss/cnn_topstories.rss"),
    Outlet(
        "New York Times",
        "lean_left",
        "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    ),
    Outlet(
        "Washington Post", "lean_left", "https://feeds.washingtonpost.com/rss/national"
    ),
    Outlet("BBC News", "center", "https://feeds.bbci.co.uk/news/rss.xml"),
    Outlet(
        "Christian Science Monitor", "center", "https://rss.csmonitor.com/feeds/usa"
    ),
    Outlet("The Hill", "center", "https://thehill.com/news/feed/"),
    Outlet("Axios", "center", "https://api.axios.com/feed/"),
    Outlet("Al Jazeera English", "center", "https://www.aljazeera.com/xml/rss/all.xml"),
    Outlet("New York Post", "lean_right", "https://nypost.com/feed/"),
    Outlet(
        "Washington Examiner", "lean_right", "https://www.washingtonexaminer.com/feed"
    ),
    Outlet(
        "Fox News", "right", "https://moxie.foxnews.com/google-publisher/latest.xml"
    ),
    Outlet(
        "Washington Times",
        "right",
        "https://www.washingtontimes.com/rss/headlines/news/",
    ),
    Outlet("National Review", "right", "https://www.nationalreview.com/feed/"),
    Outlet("The Federalist", "right", "https://thefederalist.com/feed/"),
    Outlet("Daily Wire", "right", "https://www.dailywire.com/feeds/rss.xml"),
    Outlet("Newsmax", "right", "https://www.newsmax.com/rss/Newsfront/16/"),
)

_BY_NAME = {outlet.name: outlet for outlet in OUTLETS}


def active_outlets() -> list[Outlet]:
    return [outlet for outlet in OUTLETS if outlet.active]


def get_outlet(name: str) -> Outlet | None:
    return _BY_NAME.get(name)


def empty_coverage() -> dict[str, int]:
    """A zero-filled coverage map containing all five keys, always."""
    return {lean: 0 for lean in LEANS}
