# Testing — slice 1.2

Status: the backend has had a suite since slice 1 (40 tests, `backend/tests/`).
The frontend had **nothing** — no runner, no scripts, no test files — across two
slices. This slice closes that and puts both halves behind CI.

This document is the spec the frontend agent was dispatched against, and the
thing `.github/workflows/ci.yml` depends on. Like `api-contract.md`, it is
Architect-owned: agents read it, they do not amend it.

## Runner: Vitest + React Testing Library

Chosen over Jest. Jest's `next/jest` wrapper is the officially blessed path, but
it exists to paper over Jest's CommonJS heritage, and this codebase is ESM,
TypeScript, and React 19 throughout — the thing being papered over is the thing
we have. Vitest reads the same `tsconfig.json` paths, needs no transform
pipeline, and its watch mode is fast enough to actually be used.

Not Playwright, not yet. End-to-end tests need a running backend or a mocked
network at the browser boundary, and that is a second decision with a second
CI cost. One thing at a time — this slice is unit and component tests.

| Package | Why |
|---|---|
| `vitest` | runner |
| `@vitejs/plugin-react` | JSX/Fast Refresh transform for components |
| `jsdom` | DOM for component tests |
| `@testing-library/react` | render + queries |
| `@testing-library/user-event` | realistic interaction |
| `@testing-library/jest-dom` | `toBeInTheDocument` and friends |

`@/*` resolution comes from Vite's native `resolve.tsconfigPaths: true`, which
reads the same `tsconfig.json` the app does. This started as the
`vite-tsconfig-paths` plugin; Vite 8 absorbed the feature and warns on every
run if the plugin is still present, so the plugin was dropped. The point stands
either way — the alias is defined in exactly one place.

## The script contract

CI invokes exactly these, from `frontend/`. The names are fixed — the workflow
was written against them before the tests existed, so a rename breaks CI:

| Script | Command |
|---|---|
| `test` | `vitest` (watch; for humans) |
| `test:run` | `vitest run` (single pass; for CI) |
| `typecheck` | `next typegen && tsc --noEmit` |
| `lint` | `eslint` (already existed) |

`typecheck` is listed here because `next build` type-checks but `next lint`
does not, and a test file that never gets built would otherwise be the one
place in the repo TypeScript isn't enforced.

The `next typegen` half is not decoration. `PageProps` and `LayoutProps` — used
by `app/stories/[id]/page.tsx` and `app/layout.tsx` — are globals Next
*generates* into `.next/types/` and `next-env.d.ts`, and both of those are
gitignored. A bare `tsc --noEmit` therefore passes on a developer machine with
a warm `.next/` and fails on a fresh checkout with `Cannot find name
'PageProps'`. This was written wrong the first time and caught before CI ever
ran, by type-checking with the generated inputs excluded. Running typegen first
makes the script honest for a clean clone and for CI alike.

## What is worth testing here

Ranked by what actually breaks. The frontend's risk is concentrated in pure
functions and two state machines, not in markup.

1. **`lib/api.ts`** — the contract boundary. Status/envelope → `ApiError`
   mapping, `NO_DATA` vs `NOT_FOUND` vs network, malformed envelopes, and the
   query parameter *names*. `min_sources` is snake_case on the wire and
   `minSources` in TypeScript; nothing but a test notices if that mapping
   breaks, and the failure is a silently unfiltered list.
2. **`lib/coverage.ts`** — every threshold in the product's central claim.
   Exact boundaries (0.8, 0.6), the blind-spot floor of 3 articles, and
   `total === 0` not producing `Infinity` or `NaN`.
3. **`app/stories/[id]/page.tsx`** — slice 1.1's whole point. The list-hit path
   must not fetch; the list-miss path must; a 404 renders the not-found panel;
   and an alias resolving to a different `story.id` must rewrite the URL with
   `replace`, not `push`.
4. **`components/StoriesProvider.tsx`** — the state machine every screen reads.
   Loading → each terminal state, and the ingest phase sequence
   `running → refreshing → done`.
5. **`lib/format.ts`** — boundary arithmetic, invalid input returning `""`.
6. **`components/CoverageBar.tsx`** — that the `aria-label` carries the same
   distribution the colours do. This is the accessibility promise in `lean.ts`
   made checkable.

Not worth testing: Tailwind class strings, `LEAN_META` labels, skeletons.
Asserting on styling classes produces tests that fail on every redesign and
catch nothing.

## How to fail

Pre-authorized, and required to be reported rather than worked around:

- If a component cannot be rendered in jsdom without mocking something beyond
  `next/navigation` and `fetch`, **stop and report it** rather than reshaping
  the component to be testable. Production code does not change in this slice.
- If a test would need `NEXT_PUBLIC_*` set at import time, set it in the test
  file's environment rather than making `config.ts` dynamic — the literal
  property access in `config.ts` is deliberate and load-bearing for Next's
  build-time inlining.
- A test that is hard to write because the code is genuinely tangled is a
  finding worth reporting, not a reason to skip the test silently.
