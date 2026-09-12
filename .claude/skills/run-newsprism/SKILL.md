---
name: run-newsprism
description: Build, run, and drive newsprism (FastAPI backend + Next.js frontend). Use when asked to start newsprism, launch the API or the web UI, run its tests, take a screenshot of the UI, ingest articles, or interact with the running app.
---

newsprism is two halves that run together: a FastAPI backend (`backend/`) and a
Next.js frontend (`frontend/`). Drive both with
`.claude/skills/run-newsprism/driver.mjs` — it starts each server, waits for it
properly, drives the real UI over the Chrome DevTools Protocol, and tears
everything down. **Start there, not with `npm run dev`.**

All paths below are relative to the repo root. Verified on Windows 11 (Git Bash
/ PowerShell), Node v22.19.0, Python 3.13.7.

## Prerequisites

No system packages to install. The driver has **zero npm dependencies** — Node
22 ships global `fetch` and `WebSocket`, and it talks to your already-installed
Chrome over CDP rather than downloading Playwright.

```bash
node .claude/skills/run-newsprism/driver.mjs doctor
```

```
▸ Prerequisites
  ✓ node: v22.19.0
  ✓ backend venv: ...\backend\.venv\Scripts\python.exe
  ✓ frontend node_modules: ...\frontend\node_modules
  ✓ chrome/edge: C:/Program Files/Google/Chrome/Application/chrome.exe
  ✓ sqlite db: ...\backend\data\newsprism.db
```

Fix anything it flags before going further. It looks for Chrome, then Edge.

## Setup

One-time, after a clone:

```bash
cd backend
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt -r requirements-dev.txt
cd ../frontend
npm ci
```

Verified by re-running `pip install` (resolved clean against an existing venv)
and `npm ci --dry-run` (lockfile validates, "up to date in 1s") on this machine.
The `python -m venv` line is the only step here not re-executed during
authoring — the venv already existed and recreating it would have been
destructive.

No environment variables are required — every entry in `backend/.env.example`
has a working default. The first ingest downloads a ~90 MB ONNX model from
Hugging Face into `HF_HOME` (~8.8s on a warm connection); after that it is
cached.

Do **not** install `backend/requirements-torch.txt`. That is the pre-migration
torch reference implementation, kept only to re-verify vector equivalence; it
adds ~800 MB and nothing in the running app imports it.

## Run (agent path)

```bash
node .claude/skills/run-newsprism/driver.mjs smoke
```

Starts the API on **8010** and the web UI on **3010** (deliberately not 8000 /
3000 — see Gotchas), probes every contract endpoint, loads the story list in
headless Chrome, clicks through into a story detail page, screenshots both, and
kills everything. Real output from this repo:

```
▸ Starting API on 8010
  ✓ up in 2.9s
▸ Contract endpoints
  ✓ GET /api/health → 200
     clusterer (configured): onnx
  ✓ GET /api/outlets → 200
  ✓ GET /api/stories?limit=3 → 200
  ✓ coverage invariant holds (2 === article_count)
  ✓ durable id resolves: s_0eac4f5d3fe7
  ✓ 404 returns the contract error envelope
▸ Starting web on 3010 → http://127.0.0.1:8010
  ✓ next dev ready in 8.9s
▸ Driving the real UI
  ✓ list state: stories:50
▸ Clicking into a story
  ✓ navigated to /stories/s_0eac4f5d3fe7
  ✓ detail rendered (1417 chars of text)
▸ Result
  ✓ end-to-end OK
```

Screenshots land in `.claude/skills/run-newsprism/shots/` (self-gitignored).
**Open them — a green run with a blank screenshot means the driver waited on the
wrong thing.**

| command | what it does |
|---|---|
| `smoke` | full stack + real UI + click-through. The default. |
| `api` | API only: starts uvicorn, probes every endpoint, exits. No browser. |
| `ui [scenario]` | web only, in mock mode — **no backend needed**. Scenarios: `stories`, `no_data`, `empty`, `error`, `offline`. |
| `shot <url> [out.png]` | screenshot an already-running URL. Starts nothing. |
| `eval <url> "<js>"` | evaluate a JS expression in the page, print the result. The debugging tool when a page renders wrong. |
| `doctor` | prerequisite check. |

Flags: `--api-port N` `--web-port N` `--cdp-port N` `--keep` (leave servers up)
`--headful` (visible browser). `DRIVER_VERBOSE=1` streams both servers' logs.

Useful combinations, all run:

```bash
# backend work — no browser, no frontend, fastest loop
node .claude/skills/run-newsprism/driver.mjs api

# frontend work — no backend at all; exercise an empty/error state directly
node .claude/skills/run-newsprism/driver.mjs ui no_data
node .claude/skills/run-newsprism/driver.mjs ui error

# screenshot something you already have running — note: localhost, not 127.0.0.1
node .claude/skills/run-newsprism/driver.mjs shot http://localhost:3000/ home.png

# why is the page wrong? ask it directly
node .claude/skills/run-newsprism/driver.mjs eval http://localhost:3000/ \
  "(async()=>{const r=await fetch('http://localhost:8000/api/stories?limit=2');return 'status='+r.status})()"
```

### Populating the database

A cold database makes `GET /api/stories` return `503 NO_DATA`, and `smoke`
reports `list state: no_data` rather than failing. Fill it by starting the API
**as a persistent background process** and POSTing to it:

```bash
# terminal 1 — leave running
cd backend
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8010

# terminal 2
curl -X POST http://127.0.0.1:8010/api/ingest --max-time 3600
```

Real output:

```
feeds_attempted        21
feeds_succeeded        20
feeds_failed           ['https://www.newsmax.com/rss/Newsfront/16/']
articles_ingested      594
articles_new           594
clusters_formed        44
duration_seconds       62.17
```

Ingest is synchronous and slow — **~62s** — and it encodes the window twice (a
known, documented defect). **Newsmax times out on most runs**; 20/21 feeds is a
normal result, not a failure.

To ingest without touching your real database, point it at a throwaway file:
`NEWSPRISM_DB_PATH=/c/Users/<you>/AppData/Local/Temp/scratch.db`.

`driver.mjs api --keep` also leaves the server up, but only if your shell keeps
the process group alive — under some tool runners the children are reaped when
the command returns. The two-terminal form above always works.

## Run (human path)

```bash
cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev          # → http://localhost:3000, Ctrl-C to stop
```

Only worth it if you want hot reload while editing. The driver is faster for
anything you just need to observe.

## Test

```bash
cd backend && ./.venv/Scripts/python.exe -m pytest -q     # 47 passed in 4.86s
cd frontend && npm run test:run                            # 68 passed in 26.72s
```

Both offline — no feed is fetched and no model is downloaded. Frontend
`setup`/`environment` time dominates that 27s; the tests themselves take ~1s.

## Gotchas

- **Next 16 refuses to start a second dev server for the same project
  directory, on *any* port.** Changing `--port` does not help; it reads a lock
  under `.next/dev/` and exits 1 with "Another next dev server is already
  running". There is no `--dist-dir` flag on `next dev` or `next build` to work
  around it. The driver detects this specific failure and prints the PID to
  kill. If you have a dev server open, stop it first:
  `taskkill //PID <pid> //T //F`.

- **`spawn EINVAL` when launching `next`.** Since the CVE-2024-27980 fix, Node
  refuses to spawn `.cmd`/`.bat` files without `shell: true`. Do not use
  `node_modules/.bin/next.cmd` — invoke the JS entry point with the current node
  binary instead (`node node_modules/next/dist/bin/next dev`). The driver does
  this; it is also identical on Linux.

- **The backend's default CORS list only allows port 3000.** Run the UI on any
  other port and the browser is silently CORS-blocked — you get an empty list,
  not an error banner. The driver passes `NEWSPRISM_CORS_ORIGINS` covering its
  own web port. If you start servers by hand on non-standard ports, you must do
  the same.

- **Browse `npm run dev` at `localhost:3000`, never `127.0.0.1:3000`.** Next 16
  treats them as different origins and silently blocks its own dev resources:

  ```
  ⚠ Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1"
  ```

  The symptom is a page stuck on skeleton placeholders forever — the API call
  succeeds (you can watch the `200 OK` land in the backend log) but the UI never
  paints. Nothing in the browser says why; the warning is in the *dev server's*
  stdout. Verified both ways: `shot http://127.0.0.1:3000/` gives skeletons,
  `shot http://localhost:3000/` gives stories, same server, same moment. The
  driver sidesteps this by starting Next with `--hostname 127.0.0.1` and then
  navigating to `127.0.0.1`, so the two spellings always match. If you must
  browse a `npm run dev` server by IP, add `allowedDevOrigins: ['127.0.0.1']`
  to `next.config.ts`.

- **`document.readyState === "complete"` means nothing here.** Both pages are
  `"use client"` and fetch after mount, so the document is complete while the
  list is still skeleton placeholders — screenshot then and you get an empty
  page that looks like a bug. Use the driver's `settle()` / `waitFor()` rather
  than a fixed sleep.

- **Killing the parent process leaves the port bound on Windows.** `next dev`
  spawns a child node process that outlives its parent. Kill the tree:
  `taskkill /PID <pid> /T /F`. The driver does this on exit and on SIGINT.

- **`GET /api/health` reports the *configured* clusterer, not the constructed
  one.** It cannot detect a runtime fallback to TF-IDF. To know what actually
  ran, read the ingest log line: `... using onnx:all-MiniLM-L6-v2`. If it says
  `using tfidf`, the embedding path failed and the page will render with a
  fraction of the coverage spread — which looks like thin news, not an error.

- **Headless Chrome renders the UI in dark mode** (it reports
  `prefers-color-scheme: dark`). That is the app behaving correctly, not a
  broken stylesheet.

- **Mock mode needs no backend and is the fastest way to reach an empty or error
  state.** `NEXT_PUBLIC_USE_MOCK_DATA=true` with `NEXT_PUBLIC_MOCK_SCENARIO` —
  far easier than deleting the database to see `no_data`.

## Troubleshooting

- **`Another next dev server is already running. PID: 1712`** — see Gotchas.
  `taskkill //PID 1712 //T //F`, then re-run.

- **`spawn EINVAL`** — you are spawning `next.cmd` without a shell. Use the JS
  entry point (see Gotchas).

- **`timed out after 120000ms waiting for next dev`** — usually the dev-server
  lock above; the driver normally catches it and says so. Otherwise re-run with
  `DRIVER_VERBOSE=1` to see the real error.

- **`no venv at ...python.exe`** — run the Setup block.

- **`no Chrome/Edge found`** — the driver prints the paths it checked. Install
  Chrome, or add your path to `CHROME_CANDIDATES` in `driver.mjs`.

- **Page stuck on skeleton placeholders forever, API returning 200** — two
  distinct causes, in this order. (1) You are browsing `127.0.0.1:3000` against
  a `npm run dev` server; use `localhost:3000` (see Gotchas). (2) CORS — confirm
  the browser's origin is in `NEWSPRISM_CORS_ORIGINS`. Tell them apart with:

  ```bash
  node .claude/skills/run-newsprism/driver.mjs eval <url> "document.body.innerText.slice(0,200)"
  ```

  and by grepping the dev server's own stdout for `Blocked cross-origin`.

- **`list state: no_data`** — the database is cold, not broken. Run an ingest
  (see above).
