"""Contract tests: the shapes docs/api-contract.md promises the frontend.

These run offline against a temporary SQLite file with synthetic articles. No
feed is fetched, so they are fast and deterministic; the live-network path is
exercised separately by actually running POST /api/ingest.

Every assertion here corresponds to a sentence in the contract. If one of them
fails, a frontend built against that document breaks.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import pytest

TMP_DB = Path(tempfile.gettempdir()) / "newsprism_test.db"
os.environ["NEWSPRISM_DB_PATH"] = str(TMP_DB)
os.environ["NEWSPRISM_CLUSTERER"] = "tfidf"  # no model download in tests

from fastapi.testclient import TestClient  # noqa: E402

from app import store  # noqa: E402
from app.db import connect, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.outlets import LEANS, OUTLETS, empty_coverage  # noqa: E402
from app.rss import Article, FeedResult, normalize_url, parse_feed  # noqa: E402

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture()
def client():
    if TMP_DB.exists():
        for suffix in ("", "-wal", "-shm"):
            Path(str(TMP_DB) + suffix).unlink(missing_ok=True)
    init_db()
    with TestClient(app) as test_client:
        yield test_client


def _seed(n_left: int = 2, n_right: int = 1) -> None:
    """Insert one cluster with a known lean mix."""
    articles = []
    for i in range(n_left):
        articles.append(
            Article(
                id=f"a_left{i}",
                url=f"https://left{i}.example.com/story",
                outlet="Vox",
                lean="left",
                title=f"Left headline {i}",
                summary="Lead paragraph.",
                published_at="2026-09-10T12:00:00Z",
            )
        )
    for i in range(n_right):
        articles.append(
            Article(
                id=f"a_right{i}",
                url=f"https://right{i}.example.com/story",
                outlet="Fox News",
                lean="right",
                title=f"Right headline {i}",
                summary="Lead paragraph.",
                published_at="2026-09-10T13:00:00Z",
            )
        )
    store.upsert_articles(articles)
    store.replace_clusters(
        [
            {
                "id": "c_test01",
                "title": "Representative headline",
                "summary": "Representative lead.",
                "updated_at": "2026-09-10T13:00:00Z",
                "article_ids": [a.id for a in articles],
            }
        ]
    )


# --------------------------------------------------------------------------
# GET /api/stories
# --------------------------------------------------------------------------


def test_empty_database_is_503_no_data(client):
    """A cold clone must answer 503 NO_DATA, not crash and not 200."""
    response = client.get("/api/stories")
    assert response.status_code == 503
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == "NO_DATA"


def test_stories_shape_and_coverage_invariants(client):
    _seed(n_left=2, n_right=1)
    body = client.get("/api/stories").json()

    assert set(body) == {"generated_at", "stories"}
    assert ISO_Z.match(body["generated_at"])

    story = body["stories"][0]
    assert set(story) == {
        "id",
        "title",
        "summary",
        "updated_at",
        "article_count",
        "coverage",
        "sources",
    }
    # All five keys, zero-filled. The frontend never handles a missing key.
    assert set(story["coverage"]) == set(LEANS)
    assert story["coverage"] == {
        "left": 2,
        "lean_left": 0,
        "center": 0,
        "lean_right": 0,
        "right": 1,
    }
    assert sum(story["coverage"].values()) == story["article_count"] == 3
    # sources is the whole cluster, so no second request is needed.
    assert len(story["sources"]) == 3
    assert set(story["sources"][0]) == {
        "outlet",
        "lean",
        "title",
        "url",
        "published_at",
    }
    assert ISO_Z.match(story["updated_at"])
    assert all(ISO_Z.match(s["published_at"]) for s in story["sources"])
    assert all(s["lean"] in LEANS for s in story["sources"])


def test_empty_stories_list_is_not_an_error(client):
    """Articles exist but nothing meets min_sources -> 200 with []."""
    _seed()
    response = client.get("/api/stories?min_sources=50")
    assert response.status_code == 200
    assert response.json()["stories"] == []


def test_min_sources_filters_single_outlet_clusters(client):
    _seed(n_left=1, n_right=0)  # a one-article cluster
    assert client.get("/api/stories?min_sources=2").json()["stories"] == []
    assert len(client.get("/api/stories?min_sources=1").json()["stories"]) == 1


@pytest.mark.parametrize("query", ["limit=5000", "limit=-1", "limit=0", "min_sources=-9"])
def test_out_of_range_params_clamp_rather_than_error(client, query):
    _seed()
    assert client.get(f"/api/stories?{query}").status_code == 200


@pytest.mark.parametrize("query", ["limit=abc", "limit=3.5", "limit=", "min_sources=x"])
def test_unparseable_params_are_422_invalid_param(client, query):
    _seed()
    response = client.get(f"/api/stories?{query}")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_PARAM"
    assert set(response.json()["error"]) == {"code", "message"}


def test_limit_actually_limits(client):
    _seed()
    store.replace_clusters(
        [
            {
                "id": f"c_{i}",
                "title": f"Story {i}",
                "summary": "",
                "updated_at": f"2026-09-10T1{i}:00:00Z",
                "article_ids": ["a_left0", "a_left1"] if i == 0 else [],
            }
            for i in range(3)
        ]
    )
    stories = client.get("/api/stories?limit=1&min_sources=1").json()["stories"]
    assert len(stories) <= 1


def test_stories_sorted_newest_first(client):
    _seed()
    with connect() as conn:
        conn.execute(
            "INSERT INTO clusters (id, title, summary, updated_at, article_count, formed_at)"
            " VALUES ('c_old', 'Older', '', '2026-09-01T00:00:00Z', 2, '2026-09-10T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO articles (id, url, outlet, lean, title, summary, published_at,"
            " first_seen_at, cluster_id) VALUES ('a_o1','https://o1.example.com','NPR',"
            "'lean_left','Old one','','2026-09-01T00:00:00Z','2026-09-10T00:00:00Z','c_old')"
        )
        conn.execute(
            "INSERT INTO articles (id, url, outlet, lean, title, summary, published_at,"
            " first_seen_at, cluster_id) VALUES ('a_o2','https://o2.example.com','CNN',"
            "'lean_left','Old two','','2026-09-01T00:00:00Z','2026-09-10T00:00:00Z','c_old')"
        )
    updated = [s["updated_at"] for s in client.get("/api/stories").json()["stories"]]
    assert updated == sorted(updated, reverse=True)


# --------------------------------------------------------------------------
# GET /api/outlets
# --------------------------------------------------------------------------


def test_outlets_shape(client):
    body = client.get("/api/outlets").json()
    assert set(body) == {"outlets"}
    assert len(body["outlets"]) == len(OUTLETS) == 20
    for outlet in body["outlets"]:
        assert set(outlet) == {"name", "lean", "feed_url", "active"}
        assert outlet["lean"] in LEANS
        assert isinstance(outlet["active"], bool)


def test_outlet_registry_matches_the_contract_table():
    """Guard against drift in the Architect-owned list."""
    expected = {
        ("HuffPost", "left"),
        ("Vox", "left"),
        ("The Guardian (US)", "lean_left"),
        ("NPR", "lean_left"),
        ("CNN", "lean_left"),
        ("New York Times", "lean_left"),
        ("Washington Post", "lean_left"),
        ("BBC News", "center"),
        ("Christian Science Monitor", "center"),
        ("The Hill", "center"),
        ("Axios", "center"),
        ("Al Jazeera English", "center"),
        ("New York Post", "lean_right"),
        ("Washington Examiner", "lean_right"),
        ("Fox News", "right"),
        ("Washington Times", "right"),
        ("National Review", "right"),
        ("The Federalist", "right"),
        ("Daily Wire", "right"),
        ("Newsmax", "right"),
    }
    assert {(o.name, o.lean) for o in OUTLETS} == expected


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


def test_unknown_route_uses_the_error_envelope(client):
    body = client.get("/api/does-not-exist").json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}


def test_internal_errors_do_not_leak_a_stack_trace(client, monkeypatch):
    _seed()

    def boom(*args, **kwargs):
        raise RuntimeError("secret internal detail: /Users/someone/db.sqlite")

    monkeypatch.setattr(store, "get_stories", boom)
    response = client.get("/api/stories")
    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "INTERNAL"
    assert "secret internal detail" not in body["error"]["message"]
    assert "Traceback" not in body["error"]["message"]


# --------------------------------------------------------------------------
# CORS
# --------------------------------------------------------------------------


def test_cors_allows_the_frontend_origin(client):
    response = client.options(
        "/api/stories",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors_does_not_allow_an_arbitrary_origin(client):
    response = client.get("/api/outlets", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in response.headers


# --------------------------------------------------------------------------
# Ingestion units (no network)
# --------------------------------------------------------------------------


def test_normalize_url_strips_tracking_and_trailing_slash():
    assert normalize_url(
        "https://Example.com/a/b/?utm_source=rss&utm_medium=x&id=7#frag"
    ) == "https://example.com/a/b?id=7"
    assert normalize_url("https://example.com/a/") == normalize_url(
        "https://example.com/a"
    )


def test_parse_feed_survives_malformed_xml():
    outlet = OUTLETS[1]
    body = b"""<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Good one</title><link>https://example.com/1</link>
        <pubDate>Wed, 10 Sep 2026 12:00:00 GMT</pubDate></item>
      <item><title>No link here</title></item>
      <item><title>Another</title><link>https://example.com/2</link></item>
    </channel></rss"""  # deliberately truncated closing tag
    articles = parse_feed(outlet, body)
    assert [a.title for a in articles] == ["Good one", "Another"]
    assert all(ISO_Z.match(a.published_at) for a in articles)


def test_parse_feed_rejects_a_completely_unparseable_body():
    with pytest.raises(ValueError):
        parse_feed(OUTLETS[1], b"\x00\x01 this is not xml at all")


def test_empty_feed_counts_as_a_failure_not_a_silent_success():
    """The HuffPost case: HTTP 200, valid RSS, zero items."""
    body = b"""<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Empty</title></channel></rss>"""
    assert parse_feed(OUTLETS[0], body) == []


def test_dedupe_collapses_the_same_url_across_feeds():
    from app.rss import dedupe

    def make(outlet_name, summary):
        return Article(
            id="a_x",
            url="https://example.com/same",
            outlet=outlet_name,
            lean="center",
            title="T",
            summary=summary,
            published_at="2026-09-10T12:00:00Z",
        )

    results = [
        FeedResult(outlet=OUTLETS[7], ok=True, articles=[make("BBC News", "short")]),
        FeedResult(
            outlet=OUTLETS[10], ok=True, articles=[make("Axios", "a longer summary")]
        ),
    ]
    deduped = dedupe(results)
    assert len(deduped) == 1
    assert deduped[0].summary == "a longer summary"


def test_empty_coverage_has_all_five_keys():
    assert empty_coverage() == {
        "left": 0,
        "lean_left": 0,
        "center": 0,
        "lean_right": 0,
        "right": 0,
    }


# --------------------------------------------------------------------------
# Clustering seam
# --------------------------------------------------------------------------


def test_clusterer_partitions_every_document_exactly_once():
    from app.clustering import Document, TfidfClusterer

    docs = [
        Document("d1", "Supreme Court blocks Missouri map", "Redistricting ruling."),
        Document("d2", "SCOTUS blocks Missouri congressional map", "Redistricting."),
        Document("d3", "Drone show recreates Twin Towers", "9/11 tribute in New York."),
    ]
    groups = TfidfClusterer().cluster(docs)
    flat = [doc_id for group in groups for doc_id in group]
    assert sorted(flat) == ["d1", "d2", "d3"]
    assert all(len(group) >= 1 for group in groups)


def test_clusterer_handles_an_empty_corpus():
    from app.clustering import TfidfClusterer

    assert TfidfClusterer().cluster([]) == []


def test_similar_headlines_group_and_unrelated_ones_do_not():
    from app.clustering import Document, TfidfClusterer

    docs = [
        Document("d1", "Supreme Court blocks Missouri voting map", "Court ruling."),
        Document("d2", "Supreme Court blocks Missouri voting map again", "Court ruling."),
        Document("d3", "Drone display recreates the Twin Towers", "A 9/11 tribute."),
    ]
    groups = TfidfClusterer().cluster(docs)
    pairs = {frozenset(g) for g in groups}
    assert frozenset({"d1", "d2"}) in pairs
    assert frozenset({"d3"}) in pairs
