# newsprism backend

FastAPI service for slice 1: RSS ingestion, story clustering, coverage
breakdown. Implements `docs/api-contract.md` exactly; that document is the
interface, this is one implementation of it.

## Run

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate         # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The SQLite file and its parent directory are created on first start, so a cold
clone needs no setup step. Until an ingest has run, `GET /api/stories` returns
`503 NO_DATA` — that is the designed first-run state, not a failure.

Populate it:

```bash
curl -X POST http://localhost:8000/api/ingest     # ~55s, synchronous
curl "http://localhost:8000/api/stories?limit=20&min_sources=2"
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

29 tests, no network access. They assert the contract's shapes directly: the
five-key `coverage` map, `sum(coverage) == article_count`, the error envelope,
clamping vs. 422, and the outlet table.

## Layout

```
app/
  main.py          app, CORS, the exception handlers that enforce the envelope
  routes.py        the three endpoints
  schemas.py       response models = the contract in code
  outlets.py       ARCHITECT-OWNED registry (names, leans, feeds)
  rss.py           fetch, parse, normalize, dedupe
  pipeline.py      the ingest run; representative-article selection
  store.py         all SQL; coverage invariants enforced here
  db.py            schema and connections
  errors.py        the one error envelope
  timeutil.py      the one timestamp format
  clustering/
    base.py            Document + Clusterer protocol  <- the swap point
    agglomerative.py   shared cosine grouping
    embedding.py       default: all-MiniLM-L6-v2, CPU
    tfidf.py           fallback: scikit-learn, no torch
```

## Clustering

Title + lead are embedded with `sentence-transformers/all-MiniLM-L6-v2` on CPU,
then grouped by average-linkage agglomerative clustering over cosine distance.

**Threshold: 0.62 cosine** (`NEWSPRISM_SIMILARITY_THRESHOLD`). Tuned against
524 live articles from 18 feeds:

| threshold | clusters | multi-article | cross-outlet | largest |
|---|---|---|---|---|
| 0.54 | 372 | 72 | 54 | 13 |
| 0.58 | 399 | 67 | 50 | 11 |
| **0.62** | **422** | **59** | **45** | **9** |
| 0.66 | 444 | 51 | 37 | 7 |
| 0.70 | 458 | 46 | 33 | 7 |

Below ~0.58 clusters become *topics* rather than events: at 0.54 every Lindsay
Clancy article — the lawyer's motion, three separate juror interviews and two
opinion columns — collapsed into one 13-article blob. Above ~0.66 the product's
own premise degrades: the flagship "$5,000 payout" story fell from 9 articles
across 8 outlets to 5 across 5, losing the Guardian, BBC and Al Jazeera and with
them most of the left-right spread the page exists to show.

Swap the algorithm with `NEWSPRISM_CLUSTERER=tfidf`. Nothing outside
`app/clustering/` changes. It is a genuine fallback for machines where torch
will not install, but it is much weaker: on the same 524 articles it found 9
multi-article clusters against the embedding model's 59, because it matches
words rather than meaning.

Clusters are recomputed from scratch on every ingest, over articles published
within `NEWSPRISM_CLUSTER_WINDOW_DAYS` (default 4). The window matters: without
it, evergreen coverage of a recurring subject clusters with today's news.

Each cluster's `title`/`summary` come from its **medoid** — the article nearest
the cluster centroid, i.e. the most typical phrasing. Deliberately not "the most
centrist outlet", which would be an editorial choice the product is supposed to
expose rather than make.

## Configuration

All optional; see `.env.example`. `.env` is gitignored and this repo is public.

| Variable | Default |
|---|---|
| `NEWSPRISM_DB_PATH` | `data/newsprism.db` |
| `NEWSPRISM_CLUSTERER` | `embedding` |
| `NEWSPRISM_SIMILARITY_THRESHOLD` | `0.62` |
| `NEWSPRISM_EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` |
| `NEWSPRISM_CLUSTER_WINDOW_DAYS` | `4` |
| `NEWSPRISM_ID_CONTAINMENT_THRESHOLD` | `0.5` |
| `NEWSPRISM_FEED_TIMEOUT_SECONDS` | `15` |
| `NEWSPRISM_FEED_RETRIES` | `2` |
| `NEWSPRISM_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` |

There are no secrets in slice 1. The model downloads from Hugging Face on first
use (~90 MB, cached in `~/.cache/huggingface`), so the first ingest needs
network access beyond the feeds themselves.

## Known feed failures (verified 2026-09-10)

18 of the 20 contract feeds work. Two do not, and both are reported in
`feeds_failed` on every run rather than being removed from the registry — the
outlet list is Architect-owned, and a silently missing outlet would undercut the
product's balanced-coverage claim.

| Outlet | Lean | Result |
|---|---|---|
| HuffPost | left | HTTP 200 (via a 301 to `chaski.huffpost.com`) but the RSS body contains **zero `<item>` elements**. `https://www.huffpost.com/section/politics/feed` returns 50 items and is a tested replacement candidate. |
| Newsmax | right | Read timeout, intermittent. Responded in 0.3s when probed directly, times out at 15s during most runs. |

With HuffPost down, `left` is represented by Vox alone.
