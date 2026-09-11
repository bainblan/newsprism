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
from app.config import settings  # noqa: E402
from app.db import connect, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.outlets import LEANS, OUTLETS, empty_coverage  # noqa: E402
from app.rss import Article, FeedResult, normalize_url, parse_feed  # noqa: E402

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _window_ids() -> set[str]:
    """The real in-window article set, exactly as ``pipeline.recluster`` sees it.

    Tests that seed multiple stories across several calls must pass this
    (not just the articles they personally just inserted) so the persistence
    layer's end-of-run archived recompute — which runs over *every* story,
    not just the ones touched this call — does not wrongly archive stories
    seeded by an earlier call in the same test.
    """
    return {row["id"] for row in store.articles_for_clustering(settings.cluster_window_days)}


def _track(groups: list[dict]) -> list[str]:
    """Drive ``groups`` through the real tracking/persistence path.

    Thin wrapper so tests read as "seed these articles, cluster them into
    these groups" without repeating the window-id plumbing every time.
    """
    return store.track_and_persist_stories(groups, _window_ids())


@pytest.fixture()
def client():
    if TMP_DB.exists():
        for suffix in ("", "-wal", "-shm"):
            Path(str(TMP_DB) + suffix).unlink(missing_ok=True)
    init_db()
    with TestClient(app) as test_client:
        yield test_client


def _seed(n_left: int = 2, n_right: int = 1) -> str:
    """Insert one story with a known lean mix, via the real tracking path.

    Returns the minted story id. Ids are opaque and assigned by the tracking
    layer now (there is no more hardcoded "c_test01"), so callers that need
    the id use the return value rather than a literal.
    """
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
    story_ids = _track(
        [
            {
                "article_ids": [a.id for a in articles],
                "title": "Representative headline",
                "summary": "Representative lead.",
            }
        ]
    )
    return story_ids[0]


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
        "archived",
        "article_count",
        "coverage",
        "sources",
    }
    # The list only ever returns stories inside the clustering window.
    assert story["archived"] is False
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
    for i in range(3):
        article = Article(
            id=f"a_limit{i}",
            url=f"https://limit{i}.example.com/story",
            outlet="Vox",
            lean="left",
            title=f"Limit story {i}",
            summary="",
            published_at=f"2026-09-10T1{i}:00:00Z",
        )
        store.upsert_articles([article])
        _track([{"article_ids": [article.id], "title": article.title, "summary": ""}])
    stories = client.get("/api/stories?limit=1&min_sources=1").json()["stories"]
    assert len(stories) <= 1


def test_stories_sorted_newest_first(client):
    _seed()
    with connect() as conn:
        conn.execute(
            "INSERT INTO stories (id, title, summary, updated_at, first_seen_at,"
            " last_seen_at, archived) VALUES ('s_old', 'Older', '', '2026-09-01T00:00:00Z',"
            " '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 0)"
        )
        conn.execute(
            "INSERT INTO articles (id, url, outlet, lean, title, summary, published_at,"
            " first_seen_at) VALUES ('a_o1','https://o1.example.com','NPR',"
            "'lean_left','Old one','','2026-09-01T00:00:00Z','2026-09-10T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO articles (id, url, outlet, lean, title, summary, published_at,"
            " first_seen_at) VALUES ('a_o2','https://o2.example.com','CNN',"
            "'lean_left','Old two','','2026-09-01T00:00:00Z','2026-09-10T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO story_articles (story_id, article_id, added_at)"
            " VALUES ('s_old', 'a_o1', '2026-09-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO story_articles (story_id, article_id, added_at)"
            " VALUES ('s_old', 'a_o2', '2026-09-01T00:00:00Z')"
        )
    updated = [s["updated_at"] for s in client.get("/api/stories").json()["stories"]]
    assert updated == sorted(updated, reverse=True)


# --------------------------------------------------------------------------
# GET /api/stories/{id} and ID stability (v1.1)
#
# Every test below drives the *real* tracking path (store.track_and_persist_
# stories, via the _track() helper) rather than seeding the answer directly
# at the persistence layer - that is the point of this exercise per QA's
# finding that nothing asserted ID stability before v1.1.
# --------------------------------------------------------------------------


def _article(id_, title, outlet="Vox", lean="left", published_at="2026-09-10T12:00:00Z"):
    return Article(
        id=id_,
        url=f"https://{id_}.example.com/story",
        outlet=outlet,
        lean=lean,
        title=title,
        summary="",
        published_at=published_at,
    )


def test_unchanged_story_keeps_its_id(client):
    articles = [_article("u1", "Storm hits coast"), _article("u2", "Storm hits coast", outlet="Fox News", lean="right")]
    store.upsert_articles(articles)
    group = [{"article_ids": ["u1", "u2"], "title": "Storm hits coast", "summary": ""}]

    first_id = _track(group)[0]
    second_id = _track(group)[0]

    assert first_id == second_id


def test_story_gaining_an_article_keeps_its_id(client):
    """The case v1 broke: cluster_id() hashed membership, so a4 joining a1-a3
    used to mint a brand-new, unrelated id. This must now fail against that
    old implementation and pass against the tracking layer."""
    store.upsert_articles([_article("g1", "Storm hits coast"), _article("g2", "Storm hits coast", outlet="Fox News", lean="right")])
    first_id = _track([{"article_ids": ["g1", "g2"], "title": "Storm hits coast", "summary": ""}])[0]

    store.upsert_articles([_article("g3", "Storm hits coast", outlet="BBC News", lean="center")])
    second_id = _track(
        [{"article_ids": ["g1", "g2", "g3"], "title": "Storm hits coast", "summary": ""}]
    )[0]

    assert first_id == second_id
    story = store.get_story_by_id(first_id)
    assert story["article_count"] == 3


def test_merge_larger_story_survives_loser_becomes_alias(client):
    larger_articles = [_article(f"m{i}", "Story A") for i in range(3)]
    smaller_articles = [_article("m_small", "Story B", outlet="Fox News", lean="right")]
    store.upsert_articles(larger_articles + smaller_articles)

    ids = _track(
        [
            {"article_ids": [a.id for a in larger_articles], "title": "Story A", "summary": ""},
            {"article_ids": [a.id for a in smaller_articles], "title": "Story B", "summary": ""},
        ]
    )
    larger_id, smaller_id = ids

    merged_ids = [a.id for a in larger_articles] + [a.id for a in smaller_articles]
    survivor_id = _track([{"article_ids": merged_ids, "title": "Story A", "summary": ""}])[0]

    assert survivor_id == larger_id

    response = client.get(f"/api/stories/{smaller_id}")
    assert response.status_code == 200
    assert response.json()["story"]["id"] == survivor_id


def test_split_larger_fragment_keeps_the_id(client):
    articles = [_article(f"sp{i}", "Combined story") for i in range(5)]
    store.upsert_articles(articles)
    original_id = _track(
        [{"article_ids": [a.id for a in articles], "title": "Combined story", "summary": ""}]
    )[0]

    large_fragment = [a.id for a in articles[:3]]
    small_fragment = [a.id for a in articles[3:]]
    ids = _track(
        [
            {"article_ids": large_fragment, "title": "Combined story", "summary": ""},
            {"article_ids": small_fragment, "title": "Combined story", "summary": ""},
        ]
    )
    large_id, small_id = ids

    assert large_id == original_id
    assert small_id != original_id


def test_alias_chain_flattens_and_resolves(client):
    """A retires into B, B later retires into C -> requesting A returns C,
    and the flattening happens at write time (A's own alias row is repointed
    straight to C), not just via multi-hop resolution at read time."""
    with connect() as conn:
        # s_c is the terminal, still-live survivor; s_a and s_b only ever
        # exist as retired aliases in this test.
        conn.execute(
            "INSERT INTO stories (id, title, summary, updated_at, first_seen_at,"
            " last_seen_at, archived) VALUES ('s_c', 'C', '', '2026-09-10T00:00:00Z',"
            " '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 0)"
        )
        store._retire_story(conn, "s_a", "s_b", "2026-09-10T00:00:00Z")
        store._retire_story(conn, "s_b", "s_c", "2026-09-10T00:01:00Z")
        conn.commit()

    with connect() as conn:
        assert store.resolve_story_id(conn, "s_a") == "s_c"
        row = conn.execute(
            "SELECT story_id FROM story_aliases WHERE alias_id = 's_a'"
        ).fetchone()
        assert row["story_id"] == "s_c"  # flattened, not still pointing at s_b


def test_archived_story_absent_from_list_but_lookup_returns_archived_true(client):
    old_articles = [
        _article("arch1", "Old story", published_at="2026-08-01T12:00:00Z"),
        _article("arch2", "Old story", outlet="Fox News", lean="right", published_at="2026-08-01T13:00:00Z"),
    ]
    store.upsert_articles(old_articles)
    story_id = store.track_and_persist_stories(
        [{"article_ids": ["arch1", "arch2"], "title": "Old story", "summary": ""}],
        window_ids={"arch1", "arch2"},
    )[0]

    # A later run whose real clustering window no longer contains these
    # (weeks-old) articles: nothing claims the story, so the archived
    # recompute at the end of the run marks it archived.
    store.track_and_persist_stories([], _window_ids())

    listed = client.get("/api/stories?min_sources=1").json()["stories"]
    assert all(s["id"] != story_id for s in listed)

    response = client.get(f"/api/stories/{story_id}")
    assert response.status_code == 200
    body = response.json()["story"]
    assert body["archived"] is True
    assert body["id"] == story_id


def test_story_lookup_shape_matches_a_list_element(client):
    story_id = _seed(n_left=2, n_right=1)
    body = client.get(f"/api/stories/{story_id}").json()
    assert set(body) == {"story"}
    assert set(body["story"]) == {
        "id",
        "title",
        "summary",
        "updated_at",
        "archived",
        "article_count",
        "coverage",
        "sources",
    }


def test_unknown_story_id_is_404_not_found(client):
    _seed()
    response = client.get("/api/stories/s_does_not_exist")
    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == "NOT_FOUND"


def test_unknown_story_id_on_empty_database_is_503_no_data(client):
    response = client.get("/api/stories/s_does_not_exist")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "NO_DATA"


# --------------------------------------------------------------------------
# Migration from v1
#
# This is the *actual* v1 SCHEMA (transcribed from git history, commit
# 03b1668's app/db.py), index included - not a hand-written subset. A
# simplification that dropped idx_articles_cluster previously let this
# migration look tested when it wasn't: SQLite refuses to DROP COLUMN a
# column an index still references, and every real v1 database has that
# index because it was in the original SCHEMA. A fixture without it cannot
# catch that.
# --------------------------------------------------------------------------

V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,
    outlet        TEXT NOT NULL,
    lean          TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    cluster_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cluster   ON articles (cluster_id);

CREATE TABLE IF NOT EXISTS clusters (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL,
    article_count INTEGER NOT NULL,
    formed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters (updated_at DESC);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def test_init_db_migrates_a_real_v1_database():
    """init_db() must drop idx_articles_cluster before ALTER TABLE ... DROP
    COLUMN, not just attempt the ALTER directly - on a real v1 database (this
    schema, index included) the bare ALTER fails and the old code silently
    took the "older SQLite" fallback for the wrong reason on every database,
    not just genuinely old ones.
    """
    for suffix in ("", "-wal", "-shm"):
        Path(str(TMP_DB) + suffix).unlink(missing_ok=True)

    with connect() as conn:
        conn.executescript(V1_SCHEMA)
        conn.execute(
            "INSERT INTO articles (id, url, outlet, lean, title, summary,"
            " published_at, first_seen_at, cluster_id) VALUES"
            " ('v1a', 'https://v1.example.com/story', 'Vox', 'left', 'T', 'S',"
            " '2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z', 'c_old')"
        )
        conn.execute(
            "INSERT INTO clusters (id, title, summary, updated_at,"
            " article_count, formed_at) VALUES"
            " ('c_old', 'T', 'S', '2026-09-10T12:00:00Z', 1, '2026-09-10T12:00:00Z')"
        )

    init_db()  # must not raise

    with connect() as conn:
        tables = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "clusters" not in tables

        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(articles)").fetchall()
        }
        assert "cluster_id" not in columns  # the actual bug: this used to still be present

        indexes = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        assert "idx_articles_cluster" not in indexes

        # The article itself survives the migration; only the derived
        # cluster_id column and the clusters table are gone.
        row = conn.execute("SELECT id FROM articles WHERE id = 'v1a'").fetchone()
        assert row is not None


def test_init_db_migration_is_idempotent_on_an_already_migrated_database():
    for suffix in ("", "-wal", "-shm"):
        Path(str(TMP_DB) + suffix).unlink(missing_ok=True)
    init_db()
    init_db()  # must not raise the second (or third) time around
    init_db()


# --------------------------------------------------------------------------
# GET /api/outlets
# --------------------------------------------------------------------------


def test_outlets_shape(client):
    body = client.get("/api/outlets").json()
    assert set(body) == {"outlets"}
    assert len(body["outlets"]) == len(OUTLETS) == 21
    for outlet in body["outlets"]:
        assert set(outlet) == {"name", "lean", "feed_url", "active"}
        assert outlet["lean"] in LEANS
        assert isinstance(outlet["active"], bool)


def test_outlet_registry_matches_the_contract_table():
    """Guard against drift in the Architect-owned list."""
    expected = {
        ("HuffPost", "left"),
        ("Vox", "left"),
        ("Salon", "left"),
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
