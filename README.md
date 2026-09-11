# newsprism

News coverage seen through a prism: the same story, split by where it's
reported from.

Fetches headlines from ~20 outlets across the political spectrum, clusters
articles that cover the same event, and shows how coverage divides. Inspired by
Ground News.

## Why clustering is the hard part

Summarizing an article is one API call. Recognizing that a Fox headline and an
MSNBC headline describe the *same event* is the actual engineering problem, and
everything the product claims depends on getting it right. Cluster too loosely
and unrelated stories merge; too tightly and every outlet becomes its own
cluster with no spread to compare.

## Structure

```
frontend/   Next.js (TypeScript, Tailwind, App Router)
backend/    FastAPI — ingestion, embedding, clustering
docs/       api-contract.md  ← the interface both halves are built against
```

## Running locally

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:3000. On a fresh database the app will report no
data — use the ingest action to populate it.

## Status

Slice 1: ingestion, clustering, and coverage display. No LLM synthesis yet.
