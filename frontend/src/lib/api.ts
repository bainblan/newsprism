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

  constructor(init: {
    kind: ApiErrorKind;
    message: string;
    url: string;
    status?: number;
    code?: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.url = init.url;
  }

  /** True for the 503 NO_DATA case, which is an empty state and not a failure. */
  get isNoData(): boolean {
    return this.kind === "api" && this.code === "NO_DATA";
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
    throw new ApiError({
      kind: "api",
      status: response.status,
      url,
      code: envelope?.code ?? "UNKNOWN",
      message:
        envelope?.message ??
        `The backend returned ${response.status} without a readable error envelope.`,
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
