# CLAUDE.md — newsprism

## What this is

News coverage seen through a prism: the same story, split by the political lean
of the outlets reporting it. Fetches headlines from ~20 outlets across the
spectrum, clusters articles covering the same event, and shows how coverage
divides. Inspired by Ground News.

It has a second purpose the code doesn't show: this project is how the user is
learning **agentic development** — work divided across specialized subagents
rather than done in one conversation. Both goals are real. When they conflict,
prefer the approach that makes the multi-agent workflow legible.

This directory was previously called `agent-workspace`; that was a placeholder
before the project had an identity. The two are now one thing.

## Current state (2026-09-10)

Slice 1 is **built, integrated, reviewed, and pushed** — verified running end to
end in a browser: 46 clusters from 524 articles across 18 live feeds.

```
frontend/   Next.js 15, TypeScript, Tailwind, App Router, src/ dir
backend/    FastAPI + SQLite, feedparser, sentence-transformers
docs/       api-contract.md  ← the frozen interface both halves were built against
```

Repo: https://github.com/bainblan/newsprism (public)

## Running locally

```bash
# backend — from backend/
.venv\Scripts\activate
uvicorn app.main:app --reload --port 8000

# frontend — from frontend/
npm run dev
```

A cold database returns `503 NO_DATA`; use the ingest action in the UI. First
ingest downloads a ~90 MB model from Hugging Face and takes ~56s. No environment
variables are required — every entry in `.env.example` has a working default,
and slice 1 has no secrets.

Frontend mocks work without the backend:
`NEXT_PUBLIC_USE_MOCK_DATA=true`, `NEXT_PUBLIC_MOCK_SCENARIO=no_data|stories|empty|error|offline`.

## How it works

Ingest → embed (`all-MiniLM-L6-v2`, CPU) → average-linkage agglomerative
clustering over cosine distance at **threshold 0.62** → bias-tag by outlet →
SQLite → API → coverage-spread UI.

**The clustering is the hard part, not the summarization.** Recognizing that a
Guardian headline and a National Review headline describe the same event — often
with zero shared vocabulary — is what makes the product possible. TF-IDF cannot
do it; that's why the embedding model is there. A working TF-IDF fallback exists
behind `app/clustering/base.py` and produces 9 multi-article clusters where the
embedding model produces 59, so it is a genuine fallback and genuinely much
worse.

Threshold 0.62 was chosen by sweeping 0.54–0.70 against live data and picking
the last point before the product's premise degrades: at 0.66 the flagship story
lost its Guardian, BBC, and Al Jazeera coverage — the spread the page exists to
show. Below 0.58 clusters become topics rather than events.

## Known issues

- **Cluster IDs are not stable across re-ingests.** `cluster_id()` in
  `backend/app/pipeline.py` is a SHA1 of the sorted member article IDs, and
  `recluster()` rebuilds everything each run. Any membership change yields an
  unrelated ID, so shared story URLs die. The frontend handles the symptom
  gracefully. **Fix without a contract change:** match new clusters to the
  previous run's by article overlap and inherit the ID when overlap is high
  enough. No test covers ID stability.
- **The `left` end of the spectrum is thin.** HuffPost's front-page feed returns
  200 with zero items — empty upstream. `huffpost.com/section/politics/feed`
  works but is politics-only, which is methodologically inconsistent with the
  general-news feeds everywhere else. Until resolved, `left` is Vox alone, which
  undercuts the product's balance claim. Awaiting the user's editorial decision.
- **Newsmax times out** intermittently (rate limiting); costs ~30s per ingest.
- **One known-bad cluster:** a Missouri cluster merges three distinct legal
  events. Threshold tuning does not fix it — it needs entity/date awareness.
- **The frontend has no test infrastructure at all.** No runner, no scripts, no
  test files.
- **404 uses code `NOT_FOUND`**, outside the contract's enumerated codes.

## The contract

`docs/api-contract.md` is the interface the frontend and backend agents were
built against in parallel, without seeing each other's work. It is **frozen** —
agents may not change it unilaterally; unworkable means stop and report.

QA confirmed the two halves matched exactly. The contract's one failure was an
**omission**, not a contradiction: it never specified ID stability or a
`GET /api/stories/{id}` lookup, so both agents built correctly around a gap.
Contracts fail this way far more often than by conflict — when amending it, look
for what it doesn't say.

## Agent roster

Three subagents at `C:\Users\baine\.claude\agents\`, all on **Sonnet 5** to
control cost:

| Agent | Tools | Role |
|---|---|---|
| `frontend` | Read, Glob, Grep, Bash, Edit, Write | components, pages, client state, styling |
| `backend` | Read, Glob, Grep, Bash, Edit, Write | routes, data layer, validation, auth |
| `qa` | Read, Glob, Grep, Bash — **no write tools** | review, security, tests; reports only |

QA's read-only tool list is the org chart made structural, not a request it
could forget. An agent that fixes what it finds stops being an independent
check.

### The Architect is the main session, not a subagent

The user talks to the Architect; subagents report to whoever dispatched them.
Acting as Architect:

- **Own anything both agents touch** — scaffolding, shared config, the contract.
  Parallel agents collide on shared files.
- **Fix the contract before dispatching.** Write routes, shapes, status codes,
  and error cases explicitly; hand both agents the same text. Decide in advance
  how an agent should fail — pre-authorizing a fallback and requiring it be
  reported is what keeps autonomous work trustworthy.
- **Dispatch the parallel pair in a single message**, or they run in sequence
  and you pay the coordination cost for none of the speed.
- **Verify reports rather than trusting them.** Agents have been accurate here,
  but the Architect integrates and confirms.
- **Don't write feature code.** That defeats the exercise.
- **Report honestly to the user, including agent failures.** They're learning
  what this workflow actually costs.

## Environment

| Tool | Status |
|---|---|
| Node | v22.19.0 |
| npm | 11.10.0 |
| Python | 3.13.7 — `torch` 2.8.0+cpu and `sentence-transformers` 5.1.1 install fine |
| git | 2.51.0.windows.1 |
| gh | 2.100.0 — authed as `bainblan` |
| vercel | 59.15.1 — authed as `bainblan` |
| Docker | **not installed** — needed before containerizing |

- Windows 11. PowerShell 5.1 is primary; Git Bash also available. Different
  syntax — PowerShell has no `&&`, no ternary, no `??`. Don't mix them.
- **No NVIDIA GPU** (AMD Radeon 890M integrated). CPU only; never assume CUDA.
- Git Bash mangles `/`-leading paths via MSYS conversion — run those from
  PowerShell or prefix `MSYS_NO_PATHCONV=1`.

## Network constraint: `*.vercel.app` is blocked on campus

UGA's resolvers (`128.192.0.0`, `128.192.0.1`, `168.24.81.25`) return NXDOMAIN
for every `*.vercel.app` subdomain — including third-party ones. The apex
resolves; peer platforms (`netlify.app`, `github.io`, `onrender.com`) are
unaffected. A healthy deployment therefore looks broken from campus.

Before investigating any "failed" deploy, compare
`Resolve-DnsName <host> -Server 8.8.8.8` against plain `Resolve-DnsName <host>`.
If the public resolver answers, the deploy is fine. `ipconfig /flushdns` does not
help. This once cost several rounds of chasing Vercel settings for a DNS
problem — don't repeat it.

## Deployment plan (not yet done)

**Render, not Vercel.** The backend's ~1 GB of dependencies exceeds Vercel's
function limits, SQLite needs a persistent filesystem, and model weights need a
long-lived process. Render gives Docker, persistent disks, and always-on
services — and `onrender.com` resolves on campus. Leaning toward both halves on
Render for one coherent deploy story.

## Bootstrap skill

New projects are created by a personal skill at
`C:\Users\baine\.claude\skills\new-project\SKILL.md` — scaffold, secret-scan,
public GitHub repo, optional Vercel deploy. This project deliberately deviates:
Python backend, and Render instead of Vercel.

## Open decisions

- **HuffPost feed** — swap to politics-only, add another left outlet, or both.
- **Next slice** — stabilize cluster IDs (recommended), frontend tests +
  GitHub Actions, or LLM synthesis.
- **Synthesis LLM** — hosted API (~1¢/call, better at nuance) vs local small
  model (free, slow on CPU, weaker). Needed before the synthesis feature.
- **Synthesis framing.** The user wants a "neutral take." Recommended instead:
  structured output — what all sides report, where coverage diverges, how
  language differs. LLMs asked for neutrality tend to false-balance, averaging
  positions even when one is better supported, and the failure is invisible
  because the prose reads authoritative either way. Ground News shows the spread
  rather than resolving it.

## Working agreements

- **One thing at a time.** Finish and confirm before starting the next piece.
- Repos here are created **public** — a committed secret is disclosed
  immediately and permanently.
- Keep this file current. When something planned becomes real, describe what
  actually exists.
