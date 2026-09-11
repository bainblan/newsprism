"""RSS fetching and normalization.

Design rule for this module: a single bad feed must never abort the run. Every
network call and every parse is wrapped, and failures come back as data
(:class:`FeedResult` with ``ok=False``) rather than as exceptions.

"Failure" here deliberately includes a feed that returns HTTP 200 with a
well-formed but empty body. That is what the HuffPost front-page feed does, and
treating it as success would let an outlet vanish from the product silently.
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

import feedparser
import httpx

from .config import settings
from .outlets import Outlet
from .timeutil import from_struct_time, to_iso_z, utcnow

log = logging.getLogger("newsprism.rss")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 newsprism/0.1"
)
ACCEPT = (
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, "
    "text/xml;q=0.9, */*;q=0.8"
)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Tracking parameters that vary per referrer and would otherwise defeat dedup.
_TRACKING_PREFIXES = ("utm_", "ito", "cmpid", "smid", "ref_")
_TRACKING_EXACT = {"ref", "fbclid", "gclid", "mc_cid", "mc_eid", "source", "taid"}

MAX_SUMMARY_CHARS = 600

#: Feed fetching is I/O bound; this is politeness, not a CPU limit.
MAX_FETCH_WORKERS = 8


@dataclass(frozen=True)
class Article:
    id: str
    url: str
    outlet: str
    lean: str
    title: str
    summary: str
    published_at: str  # ISO 8601 UTC, trailing Z


@dataclass
class FeedResult:
    outlet: Outlet
    ok: bool
    articles: list[Article]
    error: str | None = None
    status_code: int | None = None


def clean_text(raw: str | None) -> str:
    """Feed descriptions routinely carry HTML, entities and CDATA noise."""
    if not raw:
        return ""
    text = _TAG_RE.sub(" ", raw)
    text = html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def normalize_url(raw: str) -> str:
    """Canonical form used as the dedup key.

    Strips tracking query parameters and the fragment, lowercases the host and
    drops a trailing slash. Two outlets syndicating the same wire story still
    produce different URLs - that is clustering's job, not dedup's.
    """
    try:
        parts = urlsplit(raw.strip())
    except ValueError:
        return raw.strip()
    if not parts.scheme or not parts.netloc:
        return raw.strip()

    kept = []
    for pair in parts.query.split("&"):
        if not pair:
            continue
        key = pair.split("=", 1)[0].lower()
        if key in _TRACKING_EXACT or key.startswith(_TRACKING_PREFIXES):
            continue
        kept.append(pair)

    path = parts.path.rstrip("/") or "/"
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), path, "&".join(kept), "")
    )


def article_id(url: str) -> str:
    return "a_" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def _entry_published(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        parsed = from_struct_time(getattr(entry, key, None))
        if parsed is not None:
            return parsed
    return None


def _entry_summary(entry) -> str:
    for key in ("summary", "description", "subtitle"):
        text = clean_text(getattr(entry, key, None))
        if text:
            return text[:MAX_SUMMARY_CHARS]
    content = getattr(entry, "content", None)
    if content:
        try:
            text = clean_text(content[0].get("value"))
            if text:
                return text[:MAX_SUMMARY_CHARS]
        except (AttributeError, IndexError, TypeError):
            pass
    return ""


def parse_feed(outlet: Outlet, body: bytes) -> list[Article]:
    """Parse bytes into Articles. Malformed XML yields whatever survived.

    feedparser is deliberately lenient: it flags malformed input via ``bozo``
    but still returns the entries it recovered, so a feed with one broken
    element still contributes its other stories.
    """
    parsed = feedparser.parse(body)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"malformed feed: {parsed.bozo_exception}")

    fallback = utcnow()
    seen: set[str] = set()
    articles: list[Article] = []

    for entry in parsed.entries:
        title = clean_text(getattr(entry, "title", None))
        link = (getattr(entry, "link", None) or "").strip()
        if not title or not link:
            continue
        url = normalize_url(link)
        if not url.lower().startswith(("http://", "https://")):
            continue
        if url in seen:
            continue
        seen.add(url)

        published = _entry_published(entry)
        # A missing date is common enough that dropping the item would lose
        # real coverage; fall back to fetch time and move on.
        published_at = to_iso_z(published or fallback)

        articles.append(
            Article(
                id=article_id(url),
                url=url,
                outlet=outlet.name,
                lean=outlet.lean,
                title=title,
                summary=_entry_summary(entry),
                published_at=published_at,
            )
        )

    return articles


def fetch_feed(client: httpx.Client, outlet: Outlet) -> FeedResult:
    """Fetch and parse one feed. Never raises."""
    attempts = max(1, settings.feed_retries)
    last_error = "unknown error"
    status: int | None = None

    for attempt in range(1, attempts + 1):
        try:
            response = client.get(outlet.feed_url)
            status = response.status_code
            if status != 200:
                last_error = f"HTTP {status}"
                continue
            articles = parse_feed(outlet, response.content)
            if not articles:
                # Well-formed but empty: a real failure, not a quiet success.
                last_error = "HTTP 200 but feed contained 0 usable items"
                continue
            return FeedResult(
                outlet=outlet, ok=True, articles=articles, status_code=status
            )
        except httpx.TimeoutException:
            last_error = f"timeout after {settings.feed_timeout_seconds:g}s"
        except httpx.HTTPError as exc:
            last_error = f"{type(exc).__name__}: {exc}"[:200]
        except ValueError as exc:
            last_error = str(exc)[:200]
        except Exception as exc:  # noqa: BLE001 - a feed must never kill the run
            last_error = f"{type(exc).__name__}: {exc}"[:200]
        log.warning(
            "feed attempt %d/%d failed for %s: %s",
            attempt,
            attempts,
            outlet.name,
            last_error,
        )

    return FeedResult(
        outlet=outlet, ok=False, articles=[], error=last_error, status_code=status
    )


def fetch_all(outlets: list[Outlet]) -> list[FeedResult]:
    """Fetch every outlet concurrently, isolating failures.

    Concurrency is here for a specific reason, not for speed in general: a feed
    that hangs costs ``timeout x retries`` seconds, and serially that made one
    slow outlet dominate the whole run (a single 25s-timeout feed added 50s).
    In parallel a hung feed costs the run nothing but its own wall time.

    Results come back in outlet order regardless of completion order, so the
    run is deterministic. httpx.Client is thread-safe and shared so connection
    pooling still applies.
    """
    if not outlets:
        return []
    results: dict[str, FeedResult] = {}
    with httpx.Client(
        follow_redirects=True,
        timeout=httpx.Timeout(settings.feed_timeout_seconds),
        headers={"User-Agent": USER_AGENT, "Accept": ACCEPT},
    ) as client:
        with ThreadPoolExecutor(max_workers=min(MAX_FETCH_WORKERS, len(outlets))) as pool:
            futures = {
                pool.submit(fetch_feed, client, outlet): outlet for outlet in outlets
            }
            for future in as_completed(futures):
                outlet = futures[future]
                try:
                    results[outlet.name] = future.result()
                except Exception as exc:  # noqa: BLE001 - belt and braces
                    log.exception("unexpected failure fetching %s", outlet.name)
                    results[outlet.name] = FeedResult(
                        outlet=outlet,
                        ok=False,
                        articles=[],
                        error=f"{type(exc).__name__}: {exc}"[:200],
                    )
    return [results[outlet.name] for outlet in outlets]


def dedupe(results: list[FeedResult]) -> list[Article]:
    """Collapse to one article per normalized URL across all feeds."""
    by_url: dict[str, Article] = {}
    for result in results:
        for article in result.articles:
            existing = by_url.get(article.url)
            if existing is None or len(article.summary) > len(existing.summary):
                by_url[article.url] = article
    return list(by_url.values())
