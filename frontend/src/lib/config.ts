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

/** Request timeouts, ms. Ingest is synchronous for v1 and may take 30-60s. */
export const READ_TIMEOUT_MS = 15_000;
export const INGEST_TIMEOUT_MS = 180_000;

/** How long an ingest run typically takes, per the contract. Used for progress. */
export const INGEST_EXPECTED_SECONDS = { min: 30, max: 60 } as const;
