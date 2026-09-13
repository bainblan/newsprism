"use client";

/**
 * The single owner of story data for the whole app.
 *
 * The contract puts every article in the cluster inside `sources` on the list
 * response, so one GET /api/stories serves both the list and the detail view.
 * Holding it here means navigating into a story does not refetch, and a deep
 * link to /stories/[id] on a cold load goes through exactly the same states as
 * the list does.
 *
 * The browser talks to the backend directly (per the contract), so all fetching
 * is client-side and there is nothing to prerender but the loading state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError, fetchStories, runIngest } from "@/lib/api";
import { API_BASE_URL, INGEST_IN_PROGRESS_RELOAD_DELAY_MS } from "@/lib/config";
import type { IngestResult, StoriesResponse } from "@/lib/types";

/** How many clusters the list asks for. The contract clamps 1-100. */
const STORY_LIMIT = 50;
/** Clusters with fewer articles than this have no spread worth showing. */
const MIN_SOURCES = 2;

export type StoriesState =
  | { status: "loading" }
  /** `data.stories` may legitimately be empty. */
  | { status: "ready"; data: StoriesResponse }
  /** 503 NO_DATA — the cold-start empty state, not a failure. */
  | { status: "no_data"; message: string }
  /** No HTTP response at all: backend down, CORS refused, or timed out. */
  | { status: "unreachable"; message: string; url: string }
  /** Any other non-2xx, carrying the contract's error envelope. */
  | { status: "failed"; message: string; code?: string; httpStatus?: number };

/**
 * `in_progress` (409) and `cooldown` (429) are contract-defined *good* outcomes
 * — someone else is already updating, or the data is already fresh — and must
 * render as such, not as `failed`. `timed_out` means the client gave up
 * waiting; the run itself continues server-side, so it is not `failed` either.
 */
export type IngestPhase =
  | "idle"
  | "running"
  | "refreshing"
  | "done"
  | "failed"
  | "in_progress"
  | "cooldown"
  | "timed_out";

export interface IngestState {
  phase: IngestPhase;
  /** Wall-clock ms since the POST was issued. Real elapsed time, not a guess. */
  elapsedMs: number;
  result: IngestResult | null;
  /** Set only for `failed`. */
  error: string | null;
  /** Set for `in_progress` / `cooldown` (the server's own message, rendered
   * verbatim per the contract) and `timed_out` (our own copy — there is no
   * server message when nothing responded). */
  message: string | null;
}

const IDLE_INGEST: IngestState = {
  phase: "idle",
  elapsedMs: 0,
  result: null,
  error: null,
  message: null,
};

interface StoriesContextValue {
  state: StoriesState;
  /** True while a reload is running over data that is already on screen. */
  isRefreshing: boolean;
  refresh: () => void;
  ingest: IngestState;
  /** POST /api/ingest, then refetch the list. */
  startIngest: () => void;
  dismissIngest: () => void;
  apiBaseUrl: string;
}

const StoriesContext = createContext<StoriesContextValue | null>(null);

function toErrorState(error: unknown): StoriesState {
  if (error instanceof ApiError) {
    if (error.isNoData) {
      return { status: "no_data", message: error.message };
    }
    if (error.kind === "network") {
      return { status: "unreachable", message: error.message, url: error.url };
    }
    return {
      status: "failed",
      message: error.message,
      code: error.code,
      httpStatus: error.status,
    };
  }
  return {
    status: "failed",
    message:
      error instanceof Error
        ? error.message
        : "The app hit an unexpected error while loading stories.",
  };
}

/**
 * Fetches the list and returns the state it implies. Deliberately pure — it
 * touches no React state — so the mount effect can await it and commit the
 * result itself.
 */
async function fetchListState(): Promise<StoriesState> {
  try {
    const data = await fetchStories({
      limit: STORY_LIMIT,
      minSources: MIN_SOURCES,
    });
    return { status: "ready", data };
  } catch (error) {
    return toErrorState(error);
  }
}

export function StoriesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoriesState>({ status: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [ingest, setIngest] = useState<IngestState>(IDLE_INGEST);

  /** Guards against a slow earlier request overwriting a newer result. */
  const requestSeq = useRef(0);
  /** When the current ingest POST was issued, so elapsed time survives the
   *  running -> refreshing transition. */
  const ingestStartedAt = useRef(0);
  /**
   * The single delayed reload scheduled after a 409, so it can be cancelled
   * on dismiss or unmount instead of firing into a stale/unmounted tree.
   *
   * This is a courtesy, not a signal: the run that returned 409 takes minutes
   * (see INGEST_TIMEOUT_MS), so this GET will almost never reflect its
   * result. It exists only because a single extra GET is free and harmless,
   * not because it usefully "checks" on the other run — do not describe it
   * to the user as doing so.
   */
  const pendingReloadTimer = useRef<number | null>(null);

  const cancelPendingReload = useCallback(() => {
    if (pendingReloadTimer.current !== null) {
      window.clearTimeout(pendingReloadTimer.current);
      pendingReloadTimer.current = null;
    }
  }, []);

  useEffect(() => cancelPendingReload, [cancelPendingReload]);

  // Initial load. The state already starts as "loading", so nothing is set
  // before the request resolves.
  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;

    void (async () => {
      const next = await fetchListState();
      if (!cancelled && seq === requestSeq.current) setState(next);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** A reload over data already on screen: no skeleton, just a quiet busy flag. */
  const reload = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setIsRefreshing(true);
    try {
      const next = await fetchListState();
      if (seq === requestSeq.current) setState(next);
    } finally {
      if (seq === requestSeq.current) setIsRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void reload();
  }, [reload]);

  const startIngest = useCallback(() => {
    cancelPendingReload();
    ingestStartedAt.current = Date.now();
    setIngest({
      phase: "running",
      elapsedMs: 0,
      result: null,
      error: null,
      message: null,
    });

    void (async () => {
      try {
        const result = await runIngest();
        setIngest((previous) => ({
          ...previous,
          phase: "refreshing",
          result,
          error: null,
          message: null,
        }));

        // Ingest is only useful if the list then reflects it, so the refetch is
        // part of the same action rather than something the user has to do.
        await reload();

        setIngest((previous) => ({ ...previous, phase: "done" }));
      } catch (error) {
        if (error instanceof ApiError && error.isInProgress) {
          // Good news, not a failure: someone else's run is already going.
          // It takes minutes (INGEST_TIMEOUT_MS), so nothing here can make
          // the list current sooner — the honest thing is to say so and let
          // the person check back, which is what IngestInProgress's copy
          // does. The delayed reload below is just a free, harmless GET, not
          // a mechanism for "catching" the other run's result.
          setIngest((previous) => ({
            ...previous,
            phase: "in_progress",
            error: null,
            message: error.message,
          }));
          pendingReloadTimer.current = window.setTimeout(() => {
            pendingReloadTimer.current = null;
            void reload();
          }, INGEST_IN_PROGRESS_RELOAD_DELAY_MS);
          return;
        }

        // Deliberately NOT implemented: retrying via POST /api/ingest instead
        // of (or in addition to) this GET-only reload. It looks free — while
        // the lock is held, a POST is rejected instantly and costs nothing —
        // but if the in-progress run then FAILS, no cooldown is recorded
        // (mark_ingest_time() only runs on success). A poll landing right
        // after that failure would find the lock free and no cooldown, and
        // would kick off a brand-new, genuinely expensive ingest that nobody
        // asked for. A retry that can silently trigger the job it's
        // retrying is worse than not retrying at all.

        if (error instanceof ApiError && error.isCooldown) {
          // Also good news: a run finished too recently to bother repeating.
          // The server's message says how recently, so render it verbatim.
          setIngest((previous) => ({
            ...previous,
            phase: "cooldown",
            error: null,
            message: error.message,
          }));
          return;
        }

        if (error instanceof ApiError && error.isTimeout) {
          // No response arrived, but the run continues server-side — this is
          // not evidence of failure, just of a client-side deadline.
          setIngest((previous) => ({
            ...previous,
            phase: "timed_out",
            error: null,
            message:
              "No response yet, but the run keeps going on the server — " +
              "an ingest can take several minutes on the live host. Reload " +
              "in a bit to check for new stories.",
          }));
          return;
        }

        const message =
          error instanceof ApiError
            ? error.message
            : "The ingest run failed for an unknown reason.";
        setIngest((previous) => ({
          ...previous,
          phase: "failed",
          error: message,
          message: null,
        }));
      }
    })();
  }, [cancelPendingReload, reload]);

  const dismissIngest = useCallback(() => {
    cancelPendingReload();
    setIngest(IDLE_INGEST);
  }, [cancelPendingReload]);

  // Elapsed-time ticker. Only runs while a request is actually in flight.
  const ingestPhase = ingest.phase;
  useEffect(() => {
    if (ingestPhase !== "running" && ingestPhase !== "refreshing") return;

    const timer = window.setInterval(() => {
      setIngest((previous) =>
        previous.phase === "running" || previous.phase === "refreshing"
          ? { ...previous, elapsedMs: Date.now() - ingestStartedAt.current }
          : previous,
      );
    }, 250);

    return () => window.clearInterval(timer);
  }, [ingestPhase]);

  return (
    <StoriesContext.Provider
      value={{
        state,
        isRefreshing,
        refresh,
        ingest,
        startIngest,
        dismissIngest,
        apiBaseUrl: API_BASE_URL,
      }}
    >
      {children}
    </StoriesContext.Provider>
  );
}

export function useStories(): StoriesContextValue {
  const value = useContext(StoriesContext);
  if (!value) {
    throw new Error("useStories must be used inside <StoriesProvider>.");
  }
  return value;
}
