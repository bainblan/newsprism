# API Contract — v1.3 (slice 1 + story lookup + bounded public ingest)

**Status:** frozen. Neither the frontend nor the backend agent may change this
unilaterally. If it is unworkable, stop and report to the Architect.

**Amended 2026-09-11 by the Architect (v1 → v1.1).** v1's one failure was an
omission, not a contradiction: it never said whether a story `id` survives an
ingest run, and it offered no way to fetch a single story. Both agents built
correctly around that gap, and the result was link rot. v1.1 closes it by
adding an ID-stability guarantee, `GET /api/stories/{id}`, an `archived` flag,
and a `404 NOT_FOUND` code. The v1 shapes are otherwise unchanged — `archived`
is the only new field on an existing object.

**Amended 2026-09-12 by the Architect (v1.1 → v1.2).** `POST /api/ingest` was
public and unauthenticated — it is in the OpenAPI schema and a browser button
called it directly, so anyone with the URL could start an unbounded number of
multi-minute, CPU-bound runs on a half-CPU instance. This is an availability
problem, not a billing one. v1.2 puts the endpoint behind a shared secret, adds
`401 UNAUTHORIZED`, and removes the browser from the set of ingest clients. No
response shape changes.

**Amended 2026-09-12 by the Architect (v1.2 → v1.3).** v1.2 closed the endpoint
by controlling *who* could call it. That was the wrong axis: a token bounds the
caller, never the work. Nothing stopped the cron and an operator from ingesting
**simultaneously**, and two concurrent runs need ~710 MB on a 512 MB instance —
an OOM that takes the whole site down, with no bad actor involved. v1.3 makes
the **server** bound the work: one run at a time, and not too often. That is
what makes a public "Update news" button safe, so the browser becomes an ingest
client again.

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
      "archived": false,
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
- `archived` is **always present** and is **always `false`** in this response.
  The list only ever returns stories inside the clustering window. The field
  exists here so the story object has one shape everywhere, not two.

### ID stability (new in v1.1)

A story `id` is **durable**. It identifies the story, not its contents, and it
survives the story gaining or losing coverage.

Specifically, the frontend is entitled to rely on all of the following:

- An id, once issued, is **never reused** for a different story.
- A story that gains an article **keeps** its id. This is the case v1 broke:
  ids were a hash of the membership, so the ids that churned most were the ones
  on the widest-covered stories — exactly the stories this product exists to
  show.
- A story that loses an article, or splits, keeps its id on the **larger**
  surviving fragment.
- When two stories merge, the **larger** one's id survives; ties go to the
  older. The id that loses becomes a permanent alias for the survivor.
- An id is still opaque. The frontend must not parse it, sort by it, or infer
  anything from two ids being similar or different.

Ids are durable, not immortal: a merge retires one of two ids, and the alias
table is what keeps the retired one working. See `GET /api/stories/{id}`.

## GET /api/stories/{id}

Fetch one story by id. This is the endpoint that makes a shared URL survive —
the list response is windowed and capped at `limit`, so it cannot answer for an
old link on its own.

**Path parameter**

| Param | Type | Notes |
|---|---|---|
| `id` | string | An opaque story id. May be a current id or a retired alias. |

**200 response**

A single story object, identical in shape to one element of `stories` above,
including `sources` and the five-key `coverage`:

```json
{
  "story": {
    "id": "c_8f3a1b",
    "title": "Representative headline for the cluster",
    "summary": "Lead paragraph or feed description of the representative article.",
    "updated_at": "2026-09-10T14:23:00Z",
    "archived": false,
    "article_count": 12,
    "coverage": { "left": 3, "lean_left": 2, "center": 4, "lean_right": 2, "right": 1 },
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
}
```

Rules:

- **`min_sources` does not apply here.** If you hold a link to a story that has
  since dropped to one source, you still get the story. Filtering the list is a
  browsing decision; a direct link is a request for a specific thing.
- **`limit` does not apply here.** Position in the list is irrelevant.
- **`archived` may be `true`.** It means the story's articles have aged out of
  the clustering window, so the story no longer appears in the list and will not
  gain new coverage. It is still fully renderable from its stored sources. The
  frontend should render it normally and say plainly that it is no longer
  updating — this is an archival read, not an error.
- **Aliases resolve transparently.** Requesting a retired id returns `200` with
  the **surviving** story, whose `story.id` is the canonical id and will differ
  from the id in the URL. There is no HTTP redirect; the response body carries
  the canonical id.
- **The frontend must compare `story.id` against the requested id** and, when
  they differ, rewrite the browser URL to the canonical one without adding a
  history entry. Nothing else about rendering changes.
- Alias chains resolve fully: if `A` retired into `B` and `B` later retired into
  `C`, requesting `A` returns `C`.

**Errors**

| Status | `code` | When |
|---|---|---|
| 503 | `NO_DATA` | The database has never been populated. Same cold-start state as the list. |
| 404 | `NOT_FOUND` | The database has articles, but no story or alias matches this id. |
| 500 | `INTERNAL` | Anything else. |

`404` is the honest answer only for an id that was never issued, or one whose
story was removed outright. An id that merely gained coverage, lost coverage,
merged, split, or aged out must **not** 404 — every one of those is a case this
endpoint exists to answer.

## POST /api/ingest

Triggers a fetch-and-cluster run. Synchronous for v1 — it may take 30–60s on a
dev machine, and several minutes on a half-CPU host.

### Concurrency and rate limiting (new in v1.3)

Two rules, enforced server-side, in this order. They exist for different
reasons and must not be collapsed into one another.

**1. Cooldown — at most one run per window.** If a run completed less than
`NEWSPRISM_INGEST_COOLDOWN_SECONDS` ago (default 900 = 15 min), reject with
`429 INGEST_COOLDOWN` and a `Retry-After` header in seconds. The message must
say how recently the last run finished, in plain language, because the frontend
renders it verbatim. This is **policy**: it bounds total work and makes the
button honest, since feeds barely move in four minutes.

**2. Single-flight lock — never two runs at once.** If a run is already in
progress, reject immediately with `409 INGEST_IN_PROGRESS`. Do **not** queue,
wait, or return the in-flight result. This is **physics**: one run peaks at
355 MB of a 512 MB instance, so a second concurrent run is an out-of-memory
kill, not a slowdown.

**The lock is absolute. The cooldown is not.** A valid token bypasses the
cooldown; **nothing bypasses the lock**, including the cron. A token says "I am
allowed to ask for work more often," never "I am allowed to exhaust the host."

**The lock must be released on every exit path**, including an exception and
the total-feed-failure 503. A lock leaked on a failure wedges the endpoint
until the process restarts, which is a worse outage than the one it prevents.

It is per-process, which is correct for a single-instance deployment and
**silently wrong if the API is ever scaled to more than one instance**. Record
that here rather than discovering it under load.

### Authentication (amended in v1.3)

The `X-Ingest-Token` header from v1.2 stays, with a narrowed meaning:

```
X-Ingest-Token: <value of NEWSPRISM_INGEST_TOKEN>
```

| request | result |
|---|---|
| no header | **allowed**, subject to cooldown + lock |
| valid token | allowed, **bypasses the cooldown**, still subject to the lock |
| present but invalid token | `401 UNAUTHORIZED` |

A wrong token must stay a hard 401 rather than degrading to anonymous. The cron
runs `curl -f`, so a broken token has to surface as a failed job — degrading it
to "bounded anonymous caller" would let the scheduled ingest quietly turn into
a no-op and the site would go stale with every dashboard light green.

Compare in constant time. When `NEWSPRISM_INGEST_TOKEN` is unset there is no
valid token, so every caller is anonymous and bounded; `GET /api/health` still
reports `ingest_protected`.

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
| 401 | `UNAUTHORIZED` | `POST /api/ingest` with a present but invalid `X-Ingest-Token`. |
| 409 | `INGEST_IN_PROGRESS` | An ingest run is already running. Never two at once. |
| 429 | `INGEST_COOLDOWN` | A run finished too recently. Carries `Retry-After`. |
| 422 | `INVALID_PARAM` | Unparseable parameter (not out-of-range — those clamp) |
| 404 | `NOT_FOUND` | A named resource does not exist. Currently only `GET /api/stories/{id}`. |
| 503 | `NO_DATA` | Database is empty; ingest has never run |
| 500 | `INTERNAL` | Anything else. Never leak a stack trace into `message`. |

`NOT_FOUND` is new in v1.1. The backend was already returning it for unrouted
paths while v1's table did not list it, so this documents behaviour that
existed rather than introducing it.

`UNAUTHORIZED`, `INGEST_IN_PROGRESS` and `INGEST_COOLDOWN` apply to
`POST /api/ingest` only. **The frontend must render 409 and 429 as normal,
expected outcomes, not as failures** — "a refresh is already running" and
"already up to date" are both good news for the person who clicked. Only
`UNAUTHORIZED` stays unrenderable, since the browser never sends a token.

The frontend must handle 503 `NO_DATA` as a first-class empty state, not as a
crash. On a cold clone that is the **first** thing a user sees, so it is not an
edge case. **Reversed in v1.3:** the ingest control is public again and
`NEXT_PUBLIC_SHOW_INGEST_CONTROL` is retired, because the server now bounds the
work regardless of who clicks or how often.

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
