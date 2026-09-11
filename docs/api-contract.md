# API Contract — v1 (slice 1)

**Status:** frozen for slice 1. Neither the frontend nor the backend agent may
change this unilaterally. If it is unworkable, stop and report to the Architect.

The frontend and backend are built in parallel by agents who cannot see each
other's work. This document is the only thing keeping the two halves compatible,
so it is written to be read literally.

## Topology

- Backend: FastAPI, `http://localhost:8000`
- Frontend: Next.js, `http://localhost:3000`
- The browser calls the backend **directly**. The backend must enable CORS for
  `http://localhost:3000`.
- The frontend reads the base URL from `NEXT_PUBLIC_API_URL`, defaulting to
  `http://localhost:8000`. Never hardcode the URL at a call site.

## Shared vocabulary

`lean` is a closed enum. These five strings, exactly, lowercase with
underscores:

```
"left" | "lean_left" | "center" | "lean_right" | "right"
```

All timestamps are ISO 8601 UTC with a trailing `Z` (e.g. `2026-09-10T14:23:00Z`).

All IDs are opaque strings. The frontend must not parse them.

## GET /api/stories

Returns clustered stories, newest first.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 20 | 1–100. Out of range → clamp, do not error. |
| `min_sources` | int | 2 | Clusters with fewer articles are omitted. A single-outlet story has no spread to show. |

**200 response**

```json
{
  "generated_at": "2026-09-10T14:30:00Z",
  "stories": [
    {
      "id": "c_8f3a1b",
      "title": "Representative headline for the cluster",
      "summary": "Lead paragraph or feed description of the representative article.",
      "updated_at": "2026-09-10T14:23:00Z",
      "article_count": 12,
      "coverage": {
        "left": 3,
        "lean_left": 2,
        "center": 4,
        "lean_right": 2,
        "right": 1
      },
      "sources": [
        {
          "outlet": "Reuters",
          "lean": "center",
          "title": "The headline as that outlet wrote it",
          "url": "https://example.com/article",
          "published_at": "2026-09-10T13:00:00Z"
        }
      ]
    }
  ]
}
```

Rules the frontend is entitled to rely on:

- `coverage` **always contains all five keys**, zero-filled. The frontend must
  never handle a missing key, so the backend must never omit one.
- `sum(coverage.values()) == article_count`.
- `sources` is every article in the cluster, so the frontend can render the
  detail view without a second request.
- `stories` may be an empty array. That is a valid, non-error state.

## POST /api/ingest

Triggers a fetch-and-cluster run. Synchronous for v1 — it may take 30–60s.

**200 response**

```json
{
  "feeds_attempted": 22,
  "feeds_succeeded": 19,
  "feeds_failed": ["https://dead.example.com/rss"],
  "articles_ingested": 412,
  "articles_new": 87,
  "clusters_formed": 34,
  "duration_seconds": 41.2
}
```

Partial failure is success. Some feeds will be dead or rate-limited; report them
in `feeds_failed` and return 200 as long as *any* feed succeeded.

## GET /api/outlets

```json
{
  "outlets": [
    { "name": "Reuters", "lean": "center", "feed_url": "https://...", "active": true }
  ]
}
```

## Errors

Every non-2xx uses this envelope, with no exceptions:

```json
{ "error": { "code": "NO_DATA", "message": "Human-readable explanation." } }
```

| Status | `code` | When |
|---|---|---|
| 422 | `INVALID_PARAM` | Unparseable parameter (not out-of-range — those clamp) |
| 503 | `NO_DATA` | Database is empty; ingest has never run |
| 500 | `INTERNAL` | Anything else. Never leak a stack trace into `message`. |

The frontend must handle 503 `NO_DATA` as a first-class empty state with a
"Run ingest" affordance, not as a crash. On a cold clone that is the **first**
thing a user sees, so it is not an edge case.

## Outlet list (Architect-owned)

Bias labels are an editorial judgment, not an engineering one, so the Architect
owns this list — the backend agent implements it but must not add, remove, or
re-label outlets on its own opinion. Labels approximate widely published
media-bias assessments and are meant to be adjustable.

| Outlet | Lean | Feed |
|---|---|---|
| HuffPost | left | https://www.huffpost.com/section/politics/feed |
| Vox | left | https://www.vox.com/rss/index.xml |
| Salon | left | https://www.salon.com/feed/ |
| The Guardian (US) | lean_left | https://www.theguardian.com/us-news/rss |
| NPR | lean_left | https://feeds.npr.org/1001/rss.xml |
| CNN | lean_left | http://rss.cnn.com/rss/cnn_topstories.rss |
| New York Times | lean_left | https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml |
| Washington Post | lean_left | https://feeds.washingtonpost.com/rss/national |
| BBC News | center | https://feeds.bbci.co.uk/news/rss.xml |
| Christian Science Monitor | center | https://rss.csmonitor.com/feeds/usa |
| The Hill | center | https://thehill.com/news/feed/ |
| Axios | center | https://api.axios.com/feed/ |
| Al Jazeera English | center | https://www.aljazeera.com/xml/rss/all.xml |
| New York Post | lean_right | https://nypost.com/feed/ |
| Washington Examiner | lean_right | https://www.washingtonexaminer.com/feed |
| Fox News | right | https://moxie.foxnews.com/google-publisher/latest.xml |
| Washington Times | right | https://www.washingtontimes.com/rss/headlines/news/ |
| National Review | right | https://www.nationalreview.com/feed/ |
| The Federalist | right | https://thefederalist.com/feed/ |
| Daily Wire | right | https://www.dailywire.com/feeds/rss.xml |
| Newsmax | right | https://www.newsmax.com/rss/Newsfront/16/ |

**Verify every URL before trusting it.** Feeds move, die, start returning 403,
or return HTTP 200 with zero items — the last one is the dangerous case, because
it looks like success. Use the working set and report every failure with its
status so the Architect can replace it. Do not silently drop an outlet — losing
one end of the spectrum quietly is worse than a visible error, because the
product's whole claim is balanced coverage.

**Registry changelog**

- 2026-09-10 — HuffPost moved from `/section/front-page/feed` (HTTP 200, zero
  items, empty upstream) to `/section/politics/feed` (50 items). Caveat: this is
  politics-only where every other feed is general news, so HuffPost's
  contribution to the corpus is narrower than its peers.
- 2026-09-10 — Salon added as `left`. Rationale: `left` held only Vox once
  HuffPost broke, and the registry skewed 7 left-ish / 8 right-ish. Salon
  restores it to 8 / 5 / 8. Chosen over Mother Jones, The Nation, and The
  Intercept because it publishes high-volume general news — investigative
  outlets mostly run stories no one else covers, which produces singleton
  clusters with no spread to display. MSNBC was the first choice as the
  structural mirror of Fox News but returns HTTP 403 to feed readers; The
  Nation's feed is empty.

## Out of scope for slice 1

No LLM. No synthesis endpoint. No auth, no users, no deployment. Those come
later and are not to be anticipated in the code.
