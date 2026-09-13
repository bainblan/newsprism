/**
 * Runtime configuration. The ONLY place the API base URL is resolved.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time, so these must be
 * written as full literal property accesses — no dynamic indexing.
 */

const DEFAULT_API_BASE_URL = "http://localhost:8000";

/** Base URL of the FastAPI backend, without a trailing slash. */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

/**
 * When true, every API call is served from src/lib/mock/mock-api.ts instead of
 * the network. Off unless explicitly enabled, so mock data cannot reach a real
 * deployment by accident.
 */
export const USE_MOCK_DATA = process.env.NEXT_PUBLIC_USE_MOCK_DATA === "true";

/** Which fixture the mock API serves. Ignored unless USE_MOCK_DATA is true. */
export type MockScenario = "stories" | "no_data" | "empty" | "error" | "offline";

export const MOCK_SCENARIO: MockScenario =
  (process.env.NEXT_PUBLIC_MOCK_SCENARIO as MockScenario) || "stories";

/** Request timeouts, ms. Ingest is synchronous for v1 and may take 30-60s on a
 * dev machine, but the contract (v1.3) says several minutes on the half-CPU
 * host it's actually deployed on — 180s reported a genuinely successful
 * production run as a client-side failure. */
export const READ_TIMEOUT_MS = 15_000;
export const INGEST_TIMEOUT_MS = 300_000;

/** How long an ingest run typically takes, per the contract. Used for progress. */
export const INGEST_EXPECTED_SECONDS = { min: 30, max: 60 } as const;

/**
 * After a 409 INGEST_IN_PROGRESS, how long to wait before quietly reloading
 * the story list. Someone else's run is in flight and will eventually produce
 * new data; this is a single reload, not a poll, so it's a nicety rather than
 * a guarantee the list is current.
 */
export const INGEST_IN_PROGRESS_RELOAD_DELAY_MS = 5_000;
