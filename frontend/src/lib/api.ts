/**
 * The API client. Every network call to the backend goes through here.
 *
 * Call sites never see a URL, a status code, or a raw Response — they get typed
 * data or an ApiError. That is what makes the mock swap (see config.USE_MOCK_DATA)
 * a one-line change instead of a refactor.
 */

import {
  API_BASE_URL,
  INGEST_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  USE_MOCK_DATA,
} from "./config";
import type {
  ApiErrorEnvelope,
  IngestResult,
  OutletsResponse,
  StoriesResponse,
  Story,
  StoryLookupResponse,
} from "./types";

/**
 * `network` — the request never produced an HTTP response: backend down, DNS,
 *   CORS rejection, or timeout. The user's fix is "start the backend".
 * `api`     — the backend answered with a non-2xx and (per the contract) an
 *   error envelope. `code` is the contract's error code.
 */
export type ApiErrorKind = "network" | "api";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** The URL that was attempted — shown in the error state so it is debuggable. */
  readonly url: string;
  /** Seconds from a `Retry-After` header, when the response sent one (429). */
  readonly retryAfterSeconds?: number;

  constructor(init: {
    kind: ApiErrorKind;
    message: string;
    url: string;
    status?: number;
    code?: string;
    retryAfterSeconds?: number;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.url = init.url;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** True for the 503 NO_DATA case, which is an empty state and not a failure. */
  get isNoData(): boolean {
    return this.kind === "api" && this.code === "NO_DATA";
  }

  /** True for the 404 NOT_FOUND case: an id that was never issued or was removed. */
  get isNotFound(): boolean {
    return this.kind === "api" && this.code === "NOT_FOUND";
  }

  /** 409 — someone else's ingest run is already going. Good news, not a failure. */
  get isInProgress(): boolean {
    return this.kind === "api" && this.code === "INGEST_IN_PROGRESS";
  }

  /** 429 — a run finished too recently. Good news: the data is already fresh. */
  get isCooldown(): boolean {
    return this.kind === "api" && this.code === "INGEST_COOLDOWN";
  }

  /** The request timed out client-side. The backend may still be working —
   * this is not evidence the run failed. */
  get isTimeout(): boolean {
    return this.kind === "network" && this.code === "TIMEOUT";
  }
}

function buildUrl(path: string, params?: Record<string, string | number>): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Pull `{ error: { code, message } }` out of a body, tolerating malformed ones. */
function parseErrorEnvelope(
  body: unknown,
): { code: string; message: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as Partial<ApiErrorEnvelope>;
  const error = envelope.error;
  if (typeof error !== "object" || error === null) return null;
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    return null;
  }
  return { code: error.code, message: error.message };
}

async function request<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const {
    method = "GET",
    params,
    timeoutMs = READ_TIMEOUT_MS,
    signal,
  } = options;
  const url = buildUrl(path, params);

  // One timeout per request, combined with any caller-supplied abort signal.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: combined,
    });
  } catch {
    // fetch rejects identically for a dead server, a DNS failure and a CORS
    // refusal, so the thrown value is not informative - the abort signals are.
    if (signal?.aborted) {
      throw new ApiError({ kind: "network", message: "Request cancelled.", url });
    }
    const timedOut = timeout.aborted;
    throw new ApiError({
      kind: "network",
      url,
      message: timedOut
        ? `The backend did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : "Could not reach the backend.",
      code: timedOut ? "TIMEOUT" : "UNREACHABLE",
    });
  }

  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const envelope = parseErrorEnvelope(body);
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    throw new ApiError({
      kind: "api",
      status: response.status,
      url,
      code: envelope?.code ?? "UNKNOWN",
      message:
        envelope?.message ??
        `The backend returned ${response.status} without a readable error envelope.`,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : undefined,
    });
  }

  if (body === null) {
    throw new ApiError({
      kind: "api",
      status: response.status,
      url,
      code: "UNPARSEABLE",
      message: "The backend returned a response that was not valid JSON.",
    });
  }

  return body as T;
}

export interface FetchStoriesOptions {
  /** 1-100. Out of range is clamped by the backend, not an error. */
  limit?: number;
  /** Clusters with fewer articles are omitted. */
  minSources?: number;
  signal?: AbortSignal;
}

export async function fetchStories(
  options: FetchStoriesOptions = {},
): Promise<StoriesResponse> {
  const { limit, minSources, signal } = options;

  if (USE_MOCK_DATA) {
    const { mockFetchStories } = await import("./mock/mock-api");
    return mockFetchStories();
  }

  const params: Record<string, number> = {};
  if (limit !== undefined) params.limit = limit;
  if (minSources !== undefined) params.min_sources = minSources;

  return request<StoriesResponse>("/api/stories", { params, signal });
}

/**
 * GET /api/stories/{id}. The rescue path for a story the list can't answer
 * for: aged out (`archived: true`), past the list's `limit`, or retired into
 * a surviving story (`story.id` in the result differs from `id`). Call sites
 * are responsible for noticing that mismatch and reconciling the URL — this
 * function just resolves whatever id it's given and hands back the story.
 */
export async function fetchStory(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Story> {
  if (USE_MOCK_DATA) {
    const { mockFetchStory } = await import("./mock/mock-api");
    return mockFetchStory(id);
  }

  const { story } = await request<StoryLookupResponse>(
    `/api/stories/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  return story;
}

export async function runIngest(
  options: { signal?: AbortSignal } = {},
): Promise<IngestResult> {
  if (USE_MOCK_DATA) {
    const { mockRunIngest } = await import("./mock/mock-api");
    return mockRunIngest();
  }

  return request<IngestResult>("/api/ingest", {
    method: "POST",
    timeoutMs: INGEST_TIMEOUT_MS,
    signal: options.signal,
  });
}

/** Not used by the slice 1 UI; present so the client covers the whole contract. */
export async function fetchOutlets(
  options: { signal?: AbortSignal } = {},
): Promise<OutletsResponse> {
  if (USE_MOCK_DATA) {
    const { mockFetchOutlets } = await import("./mock/mock-api");
    return mockFetchOutlets();
  }
  return request<OutletsResponse>("/api/outlets", { signal: options.signal });
}
