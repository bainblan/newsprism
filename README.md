# newsprism

[![CI](https://github.com/bainblan/newsprism/actions/workflows/ci.yml/badge.svg)](https://github.com/bainblan/newsprism/actions/workflows/ci.yml)

News coverage seen through a prism: the same story, split by where it's
reported from.

Fetches headlines from ~20 outlets across the political spectrum, clusters
articles that cover the same event, and shows how coverage divides. Inspired by
Ground News.

## Try it

**https://newsprism-web.onrender.com**

It runs on a free tier that sleeps when idle, so the first page load can take
about 45 seconds to wake. The API behind it is public too, if you would rather
look at the data than the page:

```bash
curl https://newsprism-api-7651.onrender.com/api/health
curl 'https://newsprism-api-7651.onrender.com/api/stories?min_sources=2&limit=5'
```

## Why clustering is the hard part

Summarizing an article is one API call. Recognizing that a Fox headline and an
MSNBC headline describe the *same event* is the actual engineering problem, and
everything the product claims depends on getting it right. Cluster too loosely
and unrelated stories merge; too tightly and every outlet becomes its own
cluster with no spread to compare.

Keyword matching is not enough, and the gap is measurable. Run both over the
same window (654 articles, measured 2026-09-14) and TF-IDF finds 19
multi-article clusters, the widest of them 3 articles; sentence embeddings find
80, and the widest is 9. A cluster of 3 is not a spectrum. The outlets that
describe an event in completely different vocabulary are exactly the ones worth
putting side by side, and those are the ones keyword similarity drops.

So articles are embedded with `all-MiniLM-L6-v2` (running on `onnxruntime`, CPU
only) and grouped by average-linkage agglomerative clustering over cosine
distance. The TF-IDF path is still in the tree as a fallback, and the numbers
above are why it is only a fallback.

## Structure

```
frontend/   Next.js 16 (TypeScript, Tailwind, App Router)
backend/    FastAPI, SQLite: ingestion, embedding, clustering, story identity
docs/       api-contract.md  ← the interface both halves were built against
            testing.md, onnx-migration.md, deploy.md
.claude/    skills/run-newsprism ← launches both halves and drives the real UI
render.yaml ← the blueprint the three live services were created from
```

## Running locally

One-time setup after a clone:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows; use source .venv/bin/activate elsewhere
pip install -r requirements.txt

cd ../frontend
npm ci
```

No environment variables are required. Every entry in `backend/.env.example`
has a working default.

Then run the two halves:

```bash
# backend, from backend/
uvicorn app.main:app --reload --port 8000

# frontend, from frontend/
npm run dev
```

Open http://localhost:3000. A fresh database has no articles and the page will
say so: click **Update news** to populate it. The first ingest downloads a
~90 MB model from Hugging Face and takes about a minute; after that the model is
cached and an ingest is faster.

If you have Chrome or Edge installed, `.claude/skills/run-newsprism/` will do
all of the above for you, including waiting for both servers and clicking
through the real UI:

```bash
node .claude/skills/run-newsprism/driver.mjs doctor   # check prerequisites
node .claude/skills/run-newsprism/driver.mjs smoke    # start both, click into a story
```

It has no npm dependencies of its own.

## Tests

```bash
cd backend  && python -m pytest      # 65 tests
cd frontend && npm run test:run      # 85 tests
```

Both halves run as parallel jobs in GitHub Actions on every push. See
[docs/testing.md](docs/testing.md) for what is worth testing here and what is
deliberately not covered.

## Status

Ingestion, clustering, durable story ids, and the coverage-spread UI are built
and deployed. Ingest is public but bounded: one run at a time, with a cooldown
between runs.

No LLM synthesis yet. That is the next feature, and the open question is what
it should produce: a "neutral take" tends to false-balance, so the likely answer
is structured output showing what all sides report and where coverage diverges,
rather than a single resolved summary.
