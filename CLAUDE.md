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

## Current state (2026-09-12)

**newsprism is deployed and live.** All three Render services are up and the
product has been verified end to end in production, not just locally — see
"Deployment" below for the URLs and what the first deploy actually cost.

Slice 1 is **built, integrated, reviewed, and pushed** — verified running end to
end in a browser: 46 clusters from 524 articles across 18 live feeds.

Slice 1.1 — **durable story ids** — is built and integrated. Verified against the
project's real 628-article database, not just fixtures: a story that gained new
coverage went 9 → 10 articles and kept its id, and 503 of 503 ids survived a
re-run. The backend suite is 40 tests.

Slice 1.2 — **frontend tests + CI** — is built and reviewed. The frontend went
from zero test infrastructure to **68 tests** (Vitest + React Testing Library),
and both halves now run in GitHub Actions. It has since run on a real runner,
failed on a workflow bug, and been fixed. See "Testing and CI" below.

Slice 1.3 — **ONNX embedding backend** — is built, reviewed, and verified. torch
and sentence-transformers are gone from the default install; the same model runs
under `onnxruntime`. Peak RSS through the real ingest path fell **692 MB → 355
MB**, which is what makes a 512 MB host viable. The vectors are not merely close
but equivalent — min per-row cosine **0.99999988** against the torch baseline,
and the group partition is byte-identical on both the 856-article window and the
997-article full corpus, so the 0.62 threshold is untouched. Backend suite is 47
tests. See `docs/onnx-migration.md`.

Slices 1.4-1.5 — **ingest auth, then the correction to bounded ingest** — are
built and verified end to end against both halves running together. The public
"Update news" button is back, and the server now refuses to do more work than
it can survive. See "Ingest: bounded, not gated" below.

```
frontend/   Next.js 16, TypeScript, Tailwind, App Router, src/ dir
            *.test.ts(x) sit beside what they test; src/test/ holds fixtures
backend/    FastAPI + SQLite, feedparser, onnxruntime
            app/tracking.py ← story identity: pure, DB-free, unit-testable
            app/clustering/onnx_embedding.py ← the default embedder
            app/clustering/embedding.py      ← torch reference, not installed
docs/       api-contract.md  ← the frozen interface both halves were built against
            architecture.md  ← six Mermaid flowcharts; every node is a real file
            testing.md       ← runner choice, script contract, what's worth testing
            onnx-migration.md ← slice 1.3 spec, measured costs, equivalence proof
            deploy.md        ← the Render runbook
.github/    workflows/ci.yml ← frontend + backend as parallel jobs
.claude/    skills/run-newsprism/ ← driver.mjs + SKILL.md: launches both halves,
            drives the real UI over CDP, screenshots. Zero npm deps.
render.yaml ← the blueprint all three live services were created from
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

**Don't start with `npm run dev` — start with the driver.** The `run-newsprism`
skill (`.claude/skills/run-newsprism/`) launches both halves, waits on them
properly, drives the real UI over the Chrome DevTools Protocol, and tears it all
down. It exists because an agent could read the README and still not be able to
*see* the app.

```bash
node .claude/skills/run-newsprism/driver.mjs doctor   # prerequisites
node .claude/skills/run-newsprism/driver.mjs smoke    # both halves + click into a story
node .claude/skills/run-newsprism/driver.mjs shot <url> out.png
```

Zero npm dependencies — Node 22 ships global `fetch` and `WebSocket`, and it
speaks CDP to the already-installed Chrome rather than pulling in Playwright.
`shot` takes any URL, so it screenshots **production** as readily as localhost;
that is how the live deploy was verified. Read `SKILL.md` before using it — it
documents five failure modes no README would tell you, including that Next 16
refuses a second dev server for the same project dir on *any* port, and that
`127.0.0.1:3000` yields skeletons where `localhost:3000` yields stories.

## How it works

Ingest → embed (`all-MiniLM-L6-v2` via **onnxruntime**, CPU) → average-linkage
agglomerative clustering over cosine distance at **threshold 0.62** → bias-tag →
**match the resulting anonymous groups to durable story ids** → SQLite → API →
coverage-spread UI.

**Identity is separate from composition.** Clustering produces anonymous groups;
`app/tracking.py` matches each against the previous run's stories by article
overlap and inherits an id where the match is good enough. Story ids are UUIDs
derived from nothing, so content changing cannot invalidate them. See "Story
identity" below.

**The clustering is the hard part, not the summarization.** Recognizing that a
Guardian headline and a National Review headline describe the same event — often
with zero shared vocabulary — is what makes the product possible. TF-IDF cannot
do it; that's why the embedding model is there. A working TF-IDF fallback exists
behind `app/clustering/base.py`. Re-measured 2026-09-14 on the same 654-article
window: TF-IDF 19 multi-article clusters, widest 3; ONNX 80, widest 9. A widest
of 3 is not a spectrum, which is the product claim it fails.

Threshold 0.62 was chosen by sweeping 0.54–0.70 against live data and picking
the last point before the product's premise degrades: at 0.66 the flagship story
lost its Guardian, BBC, and Al Jazeera coverage — the spread the page exists to
show. Below 0.58 clusters become topics rather than events.

## Testing and CI (slice 1.2)

`docs/testing.md` is the spec: runner choice, the script contract, and the
ranked list of what is worth testing. Architect-owned, like the API contract.

| | |
|---|---|
| backend | 65 tests, `pytest`, offline against a temp SQLite file |
| frontend | 85 tests, Vitest + React Testing Library + jsdom |
| CI | `.github/workflows/ci.yml`, two parallel jobs |

From `frontend/`: `npm run test` (watch), `test:run` (CI), `typecheck`, `lint`.
CI runs lint → typecheck → test → build, with build last because a broken build
is the least informative failure.

**`typecheck` is `next typegen && tsc --noEmit`, and the typegen half is
load-bearing.** `PageProps` and `LayoutProps` are globals Next *generates* into
`.next/types/` and `next-env.d.ts` — both gitignored. A bare `tsc --noEmit`
passes on a dev machine with a warm `.next/` and fails on a fresh checkout. This
was written wrong the first time and caught before CI ever ran, by type-checking
with the generated inputs excluded rather than by trusting a local green.

**Run the backend suite both ways before trusting a local green** — `python -m
pytest` puts the CWD on `sys.path` and bare `pytest` does not. CI's first run
died on exactly that; `pythonpath = .` in `backend/pytest.ini` fixes both
spellings rather than pinning the workflow to one.

**Tests were verified by mutation, not by watching them pass.** Five deliberate
regressions were introduced one at a time and each had to fail the suite:
renaming the `min_sources` wire param, flipping `router.replace` to `push`,
moving `ONE_SIDED_THRESHOLD` 0.8 → 0.9, and removing each of the two async
staleness guards (`requestSeq` in the provider, `resolvedDetail` in the detail
page). A suite that has never been shown to fail is not yet evidence of
anything — this is the cheapest way to find out whether it has teeth.

**Slice 1.3 is why mutation testing is not optional here.** Deleting the ONNX
length-bucket scatter-back — which returns each article's vector to its own
index — left *all 46 tests passing*, because the fake tokenizer gave every
document the same token count, making the sort a no-op and the bucketing
untested. In production, headlines vary, batches reorder, and that break would
swap embeddings between unrelated articles silently. **A test whose fixture
flattens the variation it exists to exercise is not a test.**

Known gaps, all deliberate: the `TIMEOUT` branch in `api.ts` (needs real
`AbortSignal.timeout` expiry), the `USE_MOCK_DATA` branch, and end-to-end tests
entirely. Do not assert on Tailwind classes or `LEAN_META` label strings — those
tests fail on every redesign and catch nothing.

## Known issues

- **HuffPost's feed is politics-only.** Its front page returned 200 with zero
  items, so the registry uses `huffpost.com/section/politics/feed` — a
  methodological inconsistency with the general-news feeds everywhere else, so
  its contribution is narrower than its peers'. Salon was added so `left` is not
  one outlet; the registry is 8 left-ish / 5 center / 8 right-ish.
- **Newsmax times out** intermittently (rate limiting); costs ~30s per ingest.
- **One known-bad cluster:** a Missouri cluster merges three distinct legal
  events. Threshold tuning does not fix it — it needs entity/date awareness.
- **Every ingest encodes the clustering window twice.** `pipeline.recluster()`
  calls `clusterer.vectors()` and then `clusterer.cluster()`, and `cluster()`
  re-encodes internally. Found by QA during slice 1.3; it predates that slice
  (`embedding.py` had the same shape). Costs ~25 s of the 63.9 s ingest. Not
  fixed yet because the clean fix changes the `Clusterer` protocol so one pass
  yields both vectors and groups — a seam decision that wants its own slice.
- **CI installs `requirements.txt` only, never `requirements-torch.txt`.** The
  principle is unchanged from slice 1.2 — test the dependency set the deployment
  actually has — but the set is no longer ~1 GB. The torch extra exists only to
  re-verify ONNX/torch equivalence after a model change; nothing deployed
  imports it.

## Story identity (slice 1.1)

A story is a durable entity whose coverage changes over time. Ids are UUIDs
(`s_` + 12 hex) derived from **nothing** — an id with no relationship to content
cannot be invalidated by content changing. The v1 scheme hashed membership,
which is content-addressing applied to a mutable entity: the id churned in
proportion to how much coverage a story gained, so it failed hardest on exactly
the wide-spectrum stories the product exists to show.

Each run, `tracking.match_groups_to_stories()` scores every (new group, existing
story) pair and assigns greedily, best first, each side usable once:

- **Containment, not Jaccard.** `overlap / min(|A|,|B|)`. Jaccard punishes
  growth — a 2-article story growing to 5 scores 0.4 and would fail any sane
  threshold, breaking the id for the exact reason the fix exists. Containment
  scores it 1.0. Threshold 0.5, `NEWSPRISM_ID_CONTAINMENT_THRESHOLD`.
- **Sort by overlap *before* containment.** Load-bearing, not cosmetic: every
  overlap-of-1 pair scores containment 1.0, so containment-first lets a stray
  article outrank a genuine ancestor and steal its id.
- Greedy assignment gives merge and split for free — the larger side wins the id
  in both, ties to the older — rather than needing special cases.
- Stories are matched on their membership **restricted to the clustering
  window**, since a new group only ever holds in-window articles.

**Membership is cumulative; the 4-day window only gates clustering.** Articles
are never deleted, so a story keeps every article it ever had. `archived` means
none of its articles are still in the window: it leaves the list but stays
renderable, so an old link works rather than 404s. A merge loser becomes a
permanent alias, chains flattened, resolved with a depth cap.

## Ingest: bounded, not gated (slices 1.4-1.5)

`POST /api/ingest` is **public**. Two server-side limits protect the host:

- **Single-flight lock** — never two runs at once; a second caller gets `409`
  immediately. One run peaks at 355 MB of 512 MB, so two concurrent runs is an
  OOM. **Nothing bypasses this, including the cron.**
- **Cooldown** — at most one run per `NEWSPRISM_INGEST_COOLDOWN_SECONDS`
  (default 900); anyone sooner gets `429` plus `Retry-After`.

**The token buys a cooldown bypass, never a lock bypass**, which is what lets
the cron keep its own timetable. Slice 1.4 gated the endpoint with that token;
1.5 reversed it, since authorization bounds *who asks*, never how much work
they demand, and the OOM needs no attacker: cron firing while an operator runs
one by hand is two concurrent runs. `NEXT_PUBLIC_SHOW_INGEST_CONTROL` is retired.

`409` and `429` are **successes**, not errors — "already updating" and "already
up to date" are good news for whoever clicked. They render in `role="status"`;
only genuine failures are `role="alert"`.

**Lessons that cost something to learn:**

- **A wrong token stays a hard 401 rather than degrading to anonymous.** The
  cron uses `curl -f`, so a corrupted token must fail loudly; degrading it to
  "bounded anonymous caller" would turn the scheduled ingest into a no-op with
  every dashboard light green.
- **The lock must release on every exit path**, including the exception and the
  total-failure 503. A leaked lock wedges ingest until restart — worse than the
  outage it prevents. Deleting the `finally` fails 10 tests; that cascade is
  deliberate.
- **Never poll `POST /api/ingest` to watch a run.** It looks free, since the
  lock rejects instantly. But a failed run records no cooldown, so a poll
  landing just after one finds the lock free and **starts a real ingest nobody
  asked for**. There is no read-only in-progress signal yet.
- **Three agent mutations escaped their own first pass.** Backend auth tests
  all set the token then called only `/api/ingest`, so hoisting the dependency
  to `include_router` 401'd every reader while 54 tests stayed green. Frontend
  component tests `vi.mock` the config module, making an unsafe default
  invisible — mocking the module that holds the decision means never testing
  the decision. And a 409 panel promised the list would "reload shortly to pick
  up whatever that run finds" while reloading after 5s against a run taking
  minutes: **copy is a claim the implementation has to honour.**

## The contract

`docs/api-contract.md` is the interface the frontend and backend agents were
built against in parallel, without seeing each other's work. It is **frozen** —
agents may not change it unilaterally; unworkable means stop and report. The
Architect owns amendments; agents are read-only on `docs/`.

QA confirmed the two halves matched exactly. The contract's one failure was an
**omission**, not a contradiction: it never specified ID stability or a
`GET /api/stories/{id}` lookup, so both agents built correctly around a gap.
Contracts fail this way far more often than by conflict — when amending it, look
for what it doesn't say.

**v1.1 closed that gap** — ID stability, `GET /api/stories/{id}`, an `archived`
flag, and `404 NOT_FOUND` (which the backend was already returning while v1's
table didn't list it). Worth noting for the next amendment: the gap was found by
asking what the document *failed to say*, not by finding anything wrong in it.

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
  but the Architect integrates and confirms. Slice 1.1 is the worked example:
  both agents reported success honestly and both were right about their own
  tests, yet the backend's migration failed on every real database. Its v1
  fixture omitted `idx_articles_cluster`, and SQLite refuses to drop a column an
  index still references — so it tested a database no user has, and logged a
  confidently wrong cause. **Test fixtures that simplify the thing they stand in
  for are where agent work fails silently.** Verify against real data, and be
  ready to find your own check is the thing that's wrong: the first integration
  run here reported FAIL because the Architect's test couldn't tell a correct
  split from a broken id.
- **Don't write feature code.** That defeats the exercise.
- **Report honestly to the user, including agent failures.** They're learning
  what this workflow actually costs.

## Environment

| Tool | Status |
|---|---|
| Node | v22.19.0 |
| npm | 11.10.0 |
| Python | 3.13.7 — `onnxruntime` 1.30.0 is the default; the torch extra also installs fine |
| git | 2.51.0.windows.1 |
| gh | 2.100.0 — authed as `bainblan` |
| vercel | 59.15.1 — authed as `bainblan` |
| Docker | **not installed locally** — `backend/Dockerfile` has still never been built here, but Render built it successfully on the first try |

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

## Deployment (live on Render since 2026-09-12)

`render.yaml` and `backend/Dockerfile` are committed; `docs/deploy.md` is the
runbook. All three services were created from the blueprint and are running.

| service | type | plan | URL / notes |
|---|---|---|---|
| `newsprism-api` | web (Docker) | `0.5c-512mb` | **https://newsprism-api-7651.onrender.com** — 1 GB disk at `/data` |
| `newsprism-web` | web (Node) | `free` | **https://newsprism-web.onrender.com** — sleeps after 15 min idle |
| `newsprism-ingest` | cron | `0.5c-512mb` | `curl`s the API every 6 hours |

**The API hostname is `newsprism-api-7651`, not `newsprism-api`.** The name was
already taken globally, so Render appended a suffix. This matters more than a
cosmetic rename, because `newsprism-api.onrender.com` **resolves and answers**:
it belongs to an unrelated project also called NewsPrism ("Global News
Observatory", GraphQL at `/graphql`, REST at `/health`). It is FastAPI too, so
it returns `x-render-origin-server: uvicorn` and a plausible
`{"detail":"Not Found"}` on `/api/health`. Every instinct says "my deploy is
broken"; nothing is broken, you are reading a stranger's server. **The tell is
the error envelope** — ours is `{"error":{"code":"NOT_FOUND",...}}`, never
`{"detail":...}`. Guessed Render URLs are not safe; read the dashboard.

**Render, not Vercel.** SQLite needs a persistent filesystem and the ONNX
session needs a long-lived process; neither survives a serverless function. And
`onrender.com` resolves on campus.

The API fits `0.5c-512mb` only because of slice 1.3 — 355 MB peak with 31%
headroom. The original ~1 GB torch install is also why the dependency size
argument against Vercel is now weaker than it was; the filesystem and
process-lifetime arguments are the ones that still hold.

Decisions worth remembering:

- **The model is baked into the image at build**, and the build asserts the
  constructed clusterer is `OnnxClusterer`. A first-ingest download failure
  would otherwise degrade to TF-IDF, which still renders a page — just without
  the coverage spread the product exists to show. Silent degradation is the
  failure mode worth spending a build step on.
- **`/api/health` cannot detect that fallback**: it reports the *configured*
  clusterer from the environment, not the one actually constructed. Read the
  ingest log line (`... using onnx:all-MiniLM-L6-v2`) instead. Worth fixing.
  **From outside the box, count multi-source clusters instead** —
  `/api/stories?min_sources=2&limit=100`. Embeddings give ~50–59, TF-IDF gives
  9, so the two are never ambiguous. The production deploy returned **51**, and
  its top story clustered 8 outlets across 4 lean buckets under headlines
  sharing almost no vocabulary ("calls for AI development slowdown" / "pitches
  AI slow-down plan"), which is the thing TF-IDF provably cannot do.
- **The frontend must be rebuilt, not restarted, when `NEXT_PUBLIC_API_URL`
  changes** — Next inlines it at build time. This was observed, not theorized:
  the first live bundle shipped with `http://localhost:8000` compiled in and
  only picked up the real API after **Manual Deploy → Clear build cache &
  deploy**. To check it from outside, grep the served chunks:
  `curl -s <web>/ | grep -o '/_next/static/chunks/[^"]*\.js'`, then grep those
  for `onrender.com`. The compiled bundle is the only thing that tells the
  truth; the dashboard will happily show the new value next to a stale build.
- **`NEWSPRISM_CORS_ORIGINS` must be the exact browser origin, no trailing
  slash.** `_env_list` splits on commas and strips whitespace but **not**
  slashes, and Starlette compares `Origin` byte-for-byte, so
  `https://newsprism-web.onrender.com/` silently rejects every request.
  **Diagnose it by control, not by guessing:** send `Origin:
  http://localhost:3000`. If *that* is allowed, the variable is unset or empty —
  `localhost:3000` is only ever the hardcoded default in `config.py`. A rejected
  origin returns `400 Disallowed CORS origin` with no
  `access-control-allow-origin` header.
- **Two env vars can't be auto-wired.** `fromService` exposes only private
  hostnames; the browser needs public URLs. The cron job avoids this by using
  the private network, since its client isn't a browser.
- **The Dockerfile built on Render's first attempt** despite never having been
  built locally; CI proving the Linux pins resolve on 3.13 de-risked it.
- **Auto-deploy works, and so does blueprint auto-sync** (observed 2026-09-12,
  slice 1.4). An earlier note here said neither did, because the first build
  logged "it looks like we don't have access to your repo, but we'll try to
  clone it anyway" and succeeded anyway on an anonymous public clone. That
  inference was wrong: a plain `git push` to `main` re-synced `render.yaml`,
  created the new `NEWSPRISM_INGEST_TOKEN` (so `generateValue` *did* fire on an
  existing service), and redeployed both web services with no dashboard visit.
  **Plan for a push to reach production on its own.**
- **A deploy of the API looks exactly like an outage.** Its disk rules out
  zero-downtime deploys, so `/api/health` 502s for ~40s while Render stops the
  old instance and starts the new one. During slice 1.4 that window was briefly
  misread as a request having crashed the service. Check for an in-progress
  deploy before diagnosing anything else.

## Bootstrap skill

New projects are created by a personal skill at
`C:\Users\baine\.claude\skills\new-project\SKILL.md` — scaffold, secret-scan,
public GitHub repo, optional Vercel deploy. This project deliberately deviates:
Python backend, and Render instead of Vercel.

## Open decisions

- **A read-only ingest-status signal** is now the strongest candidate. Nothing
  can ask "is a run happening?" without POSTing, which can start one. The same
  slice should fix `/api/health` reporting the *configured* clusterer rather
  than the constructed one, so a silent TF-IDF fallback stops being invisible.
- **The double encode per ingest** (see "Known issues") — worth a slice on its
  own. The fix is a `Clusterer` protocol change so one pass returns vectors and
  groups together, which touches the seam every clusterer implements.
- **End-to-end tests** — out of scope in 1.2, and cheaper now: `driver.mjs`
  already launches both halves and drove the whole 1.5 integration check
  (409/429/failure panels against a real backend). The work is promoting that
  into `e2e/` with assertions, not adopting Playwright from scratch.
- **Synthesis LLM** — hosted API (~1¢/call, better at nuance) vs local small
  model (free, slow on CPU, weaker). Needed before the synthesis feature.
- **Synthesis framing.** The user wants a "neutral take." Recommended instead:
  structured output — what all sides report, where coverage diverges, how
  language differs. LLMs asked for neutrality tend to false-balance, averaging
  positions even when one is better supported, and the failure is invisible
  because the prose reads authoritative either way. Ground News shows the spread
  rather than resolving it.

## Working agreements

- **Report in bullets, not prose.** The user reads reports as **bolded
  headlines** with bullets under them — at most 10 bullets, and fewer is better.
  Never drop a key detail to hit the count; cut the throat-clearing instead. A
  short table beats a bulleted list of the same facts. Long paragraphs are the
  thing to avoid, not length itself.
- **One thing at a time.** Finish and confirm before starting the next piece.
- Repos here are created **public** — a committed secret is disclosed
  immediately and permanently.
- Keep this file current. When something planned becomes real, describe what
  actually exists.
- **Hard cap: 500 lines.** Every slice wants to add to this file, so adding must
  cost something. At the cap, earn the space by deleting — the first candidates
  are narratives of problems that are now fixed and can't recur, which belong in
  `docs/` or the git history rather than here. Check with `wc -l CLAUDE.md`.
