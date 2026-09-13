# Deploying newsprism to Render

`render.yaml` at the repo root is the blueprint. It declares three services:

| service | type | plan | notes |
|---|---|---|---|
| `newsprism-api` | web (Docker) | `0.5c-512mb` | 1 GB disk at `/data` for SQLite |
| `newsprism-web` | web (Node) | `free` | sleeps after 15 min idle |
| `newsprism-ingest` | cron | `0.5c-512mb` | `curl`s the API every 6 hours |

## Why Render, and why these plans

The backend needs a persistent filesystem for SQLite and a long-lived process
holding an ONNX session; neither survives a serverless function. `onrender.com`
also resolves on the UGA campus network, where every `*.vercel.app` subdomain
returns NXDOMAIN.

`0.5c-512mb` is only viable because of slice 1.3. Peak RSS through the real
ingest path is **355 MB** (31% headroom); before the ONNX migration it was
692 MB and this plan would have been OOM-killed mid-ingest.

## First deploy

1. **Render dashboard → New → Blueprint**, point it at `bainblan/newsprism`,
   and let it read `render.yaml` from `main`.
2. Render will prompt for the two values marked `sync: false`. **They are not
   knowable yet** — the services do not exist, so their URLs do not either.
   Enter placeholders and correct them in step 4, or leave them and expect the
   first frontend load to fail.
3. Let all three services build. The API build is the slow one: it installs the
   dependency set and bakes the ~90 MB ONNX model into the image.
4. Once both web services are live, copy their public URLs and set:

   | service | variable | value |
   |---|---|---|
   | `newsprism-api` | `NEWSPRISM_CORS_ORIGINS` | `https://newsprism-web.onrender.com` |
   | `newsprism-web` | `NEXT_PUBLIC_API_URL` | `https://newsprism-api.onrender.com` |

   Use the URLs Render actually assigned. If either name was taken globally,
   Render appends a suffix and the URL will not match the guess above.

5. **Rebuild the frontend — a restart is not enough.** `NEXT_PUBLIC_*` is
   inlined into the client bundle at build time, so changing it and restarting
   leaves the old value compiled into the JavaScript. Use *Manual Deploy →
   Clear build cache & deploy*. The API only needs a restart, which Render does
   automatically when an env var changes.

### Why those two cannot be wired automatically

Render's `fromService` exposes only **private network** hostnames (`host`,
`port`, `hostport`). Both of these need the **public** `onrender.com` URL: the
browser is the client for `NEXT_PUBLIC_API_URL`, and `NEWSPRISM_CORS_ORIGINS` is
compared against a browser `Origin` header. A private hostname is wrong for
both. The cron job *does* use the private network, because its client is the
cron container rather than a browser — which is why it needs no manual URL.

## Ingest is authenticated

`POST /api/ingest` requires a shared secret in an `X-Ingest-Token` header. It
starts a multi-minute, CPU-bound run on half a CPU, so an open endpoint is an
availability hole rather than a billing one: anyone with the URL can start
unbounded runs and make the site unresponsive for everyone else.

The blueprint wires this with no typing. `newsprism-api` declares the variable
with `generateValue: true`, and `newsprism-ingest` reads *the same variable off
that service* via `fromService: { envVarKey: NEWSPRISM_INGEST_TOKEN }` — the
one form of `fromService` that copies a value instead of a hostname. The secret
therefore exists in exactly one place and is never pasted anywhere.

**On a deployment that predates this change, the variable does not appear by
itself.** `generateValue` fires when a service is created. Sync the blueprint
from the dashboard so Render picks up both new entries; if no value is
generated on the API, set one there by hand (any long random string) and sync
again so the cron inherits it. Then confirm with the health check below and by
running the cron job manually once.

**When the variable is unset the endpoint stays open**, so that a fresh clone
works with no configuration. That is the wrong state for a deployment, and it
is visible from outside: `GET /api/health` reports `"ingest_protected"`.

The browser is not an ingest client. `NEXT_PUBLIC_*` values are compiled into
the JavaScript bundle, so the frontend cannot hold this secret — the ingest
button is hidden unless `NEXT_PUBLIC_SHOW_INGEST_CONTROL=true`, which is for
local development only and must never be set on `newsprism-web`.

## First data

A fresh deploy has an empty database and `GET /api/stories` returns
`503 NO_DATA`. Either wait for the cron job, or trigger one immediately — with
the token, which you read from the `newsprism-api` service's environment in the
dashboard:

```
curl -X POST https://newsprism-api-7651.onrender.com/api/ingest   -H "X-Ingest-Token: $NEWSPRISM_INGEST_TOKEN" --max-time 3600
```

Note the hostname: the API is **`newsprism-api-7651`**. `newsprism-api` was
taken globally and belongs to an unrelated project that also answers on
`/api/*` — see CLAUDE.md. Read the URL off the dashboard, never guess it.

Expect **several minutes** on half a CPU — the 63.9 s measured on a dev machine
is a floor, not an estimate. Render allows up to 100 minutes for a response, so
a slow ingest is not a timeout risk; the `--max-time` above is the binding one.

## Verifying it actually worked

`GET /api/health` returns `{"status": "ok", "clusterer": "onnx",
"ingest_protected": "true"}`.

`ingest_protected` is the one field here that tells the truth about runtime
state: `"false"` means `NEWSPRISM_INGEST_TOKEN` is unset and anyone can start
an ingest run. Check it after any blueprint change.

`clusterer` does **not** work that way — it reports the **configured** value
from the environment, not the clusterer that was actually constructed, so it
cannot detect a runtime fallback.

To confirm real clustering, read the ingest logs for:

```
clustered N articles into M groups (K multi-source) using onnx:all-MiniLM-L6-v2
```

If that line ends in `using tfidf`, the embedding path failed at runtime and
`pipeline.recluster` degraded. The page will still render — with a fraction of
the multi-source clusters, which is the one thing the product exists to show.
That silent-degradation mode is why the Docker build asserts the clusterer is
`OnnxClusterer` and fails rather than shipping a quietly broken image.

## Things that will look like bugs and are not

- **The frontend takes ~1 minute to load after idle.** Free plans sleep after 15
  minutes. The API does not sleep; it is on a paid plan.
- **Deploys of the API have a few seconds of downtime.** A service with a disk
  cannot do zero-downtime deploys — Render stops the old instance before
  starting the new one, so two versions never write the same SQLite file.
- **On the UGA campus network, check DNS before believing an outage.** Compare
  `Resolve-DnsName <host> -Server 8.8.8.8` against plain `Resolve-DnsName
  <host>`. This bit the project once already with Vercel.

## Cost notes

Confirm current prices on Render's pricing page before relying on them; the
figures discussed during this work were approximate. The disk is negligible
(~$0.25/GB/month for a database measured in single-digit megabytes). The cron
job bills only while it runs — a few minutes every six hours.

## Not yet done

- **The Dockerfile has never been built locally.** Docker is not installed on
  the dev machine, so Render's build is its first real test. CI does prove the
  Linux dependency pins resolve on Python 3.13, which is the most likely thing
  to break.
- No custom domain, no staging environment, no database backups. The disk
  survives deploys and restarts; it is not a backup.
