/**
 * Types mirroring docs/api-contract.md v1 (slice 1) exactly.
 *
 * This file is the single source of truth for the shape of the wire format.
 * The contract is frozen: do not widen, narrow, or "improve" anything here
 * without the contract changing first.
 */

/**
 * A closed enum, ordered left -> right. The order of this array is load-bearing:
 * it defines the visual order of the coverage spectrum everywhere in the UI.
 */
export const LEANS = [
  "left",
  "lean_left",
  "center",
  "lean_right",
  "right",
] as const;

export type Lean = (typeof LEANS)[number];

/** Article counts per lean. The contract guarantees all five keys, zero-filled. */
export type Coverage = Record<Lean, number>;

/** One article inside a cluster, as a single outlet wrote it. */
export interface SourceArticle {
  outlet: string;
  lean: Lean;
  title: string;
  /** Absolute URL to the original article. */
  url: string;
  /** ISO 8601 UTC, trailing Z. */
  published_at: string;
}

/** A cluster of articles covering the same event. */
export interface Story {
  /** Opaque. Never parse it. */
  id: string;
  title: string;
  summary: string;
  /** ISO 8601 UTC, trailing Z. */
  updated_at: string;
  article_count: number;
  /** Always all five keys. sum(coverage) === article_count. */
  coverage: Coverage;
  /** Every article in the cluster — the detail view needs no second request. */
  sources: SourceArticle[];
}

/** GET /api/stories 200 */
export interface StoriesResponse {
  /** ISO 8601 UTC, trailing Z. */
  generated_at: string;
  /** May be empty. That is valid, not an error. */
  stories: Story[];
}

/** POST /api/ingest 200 */
export interface IngestResult {
  feeds_attempted: number;
  feeds_succeeded: number;
  /** Feed URLs that failed. Partial failure is still a 200. */
  feeds_failed: string[];
  articles_ingested: number;
  articles_new: number;
  clusters_formed: number;
  duration_seconds: number;
}

/** GET /api/outlets 200 — not consumed by slice 1 UI, typed for completeness. */
export interface Outlet {
  name: string;
  lean: Lean;
  feed_url: string;
  active: boolean;
}

export interface OutletsResponse {
  outlets: Outlet[];
}

/** Documented error codes. The backend may in principle send others. */
export type ApiErrorCode = "INVALID_PARAM" | "NO_DATA" | "INTERNAL";

/** The error envelope used by every non-2xx response, with no exceptions. */
export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode | (string & {});
    message: string;
  };
}
