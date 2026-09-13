/**
 * components/StoriesProvider.tsx — the state machine every screen reads.
 *
 * `fetchStories` / `runIngest` are mocked; nothing here hits the network.
 * `ApiError` is the real class (constructing it directly is how the mocked
 * rejections are shaped so the provider's own instanceof checks exercise the
 * real branch logic).
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchStories, runIngest } from "@/lib/api";
import { StoriesProvider, useStories } from "@/components/StoriesProvider";
import type { IngestResult, StoriesResponse } from "@/lib/types";
import { makeStory } from "@/test/fixtures";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStories: vi.fn(),
    runIngest: vi.fn(),
  };
});

const mockedFetchStories = vi.mocked(fetchStories);
const mockedRunIngest = vi.mocked(runIngest);

/** A promise plus its resolvers, so a test can control exactly when it settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Consumer() {
  const { state, ingest, startIngest, refresh } = useStories();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="count">
        {state.status === "ready" ? state.data.stories.length : "-"}
      </span>
      <span data-testid="ingest-phase">{ingest.phase}</span>
      <span data-testid="elapsed">{ingest.elapsedMs}</span>
      <span data-testid="ingest-error">{ingest.error ?? ""}</span>
      <span data-testid="ingest-message">{ingest.message ?? ""}</span>
      <button onClick={startIngest}>start</button>
      <button onClick={refresh}>refresh</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <StoriesProvider>
      <Consumer />
    </StoriesProvider>,
  );
}

const sampleList: StoriesResponse = {
  generated_at: "2026-09-10T00:00:00Z",
  stories: [makeStory(), makeStory({ id: "s_2" })],
};

const sampleIngestResult: IngestResult = {
  feeds_attempted: 18,
  feeds_succeeded: 17,
  feeds_failed: ["https://dead-feed.example/rss"],
  articles_ingested: 500,
  articles_new: 40,
  clusters_formed: 46,
  duration_seconds: 42.5,
};

describe("StoriesProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts in loading, then reaches ready with the fetched data", async () => {
    mockedFetchStories.mockResolvedValue(sampleList);
    renderProvider();

    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });

  it("reaches no_data on a 503 NO_DATA ApiError", async () => {
    mockedFetchStories.mockRejectedValue(
      new ApiError({
        kind: "api",
        status: 503,
        code: "NO_DATA",
        message: "empty database",
        url: "http://localhost:8000/api/stories",
      }),
    );
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("no_data"));
  });

  it("reaches unreachable on a network ApiError", async () => {
    mockedFetchStories.mockRejectedValue(
      new ApiError({
        kind: "network",
        code: "UNREACHABLE",
        message: "Could not reach the backend.",
        url: "http://localhost:8000/api/stories",
      }),
    );
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unreachable"));
  });

  it("reaches failed on any other non-2xx ApiError", async () => {
    mockedFetchStories.mockRejectedValue(
      new ApiError({
        kind: "api",
        status: 500,
        code: "INTERNAL",
        message: "boom",
        url: "http://localhost:8000/api/stories",
      }),
    );
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("failed"));
  });

  it("a stale request that resolves after a newer one does not clobber it (requestSeq guard)", async () => {
    // Two requests end up in flight: the initial mount load, and a refresh()
    // fired before that load resolves. Deliberately resolve them out of
    // order — the stale (first) one last — since that is the only ordering
    // that distinguishes "ignore anything not the latest seq" from "last
    // write wins", which is what the guard exists to prevent.
    const initialGate = deferred<StoriesResponse>();
    const refreshGate = deferred<StoriesResponse>();
    mockedFetchStories
      .mockReturnValueOnce(initialGate.promise)
      .mockReturnValueOnce(refreshGate.promise);

    renderProvider();
    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    // Fire the newer request while the initial one is still pending.
    await act(async () => {
      screen.getByRole("button", { name: "refresh" }).click();
    });
    expect(mockedFetchStories).toHaveBeenCalledTimes(2);

    // Newer request resolves first.
    const newerList: StoriesResponse = {
      generated_at: "2026-09-11T00:00:00Z",
      stories: [makeStory({ id: "s_newer" })],
    };
    await act(async () => {
      refreshGate.resolve(newerList);
      await refreshGate.promise;
    });
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    // Stale (first) request resolves last. Without the requestSeq guard this
    // would overwrite the newer result with the stale one.
    const staleList: StoriesResponse = {
      generated_at: "2026-09-10T00:00:00Z",
      stories: [],
    };
    await act(async () => {
      initialGate.resolve(staleList);
      await initialGate.promise;
    });

    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });

  it("walks the ingest phase sequence running -> refreshing -> done, ticking elapsedMs on the 250ms interval", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    // Fake timers only from here: the initial `waitFor` above polls with a
    // real setTimeout, and faking timers before it resolves would hang it.
    vi.useFakeTimers();

    const ingestGate = deferred<IngestResult>();
    mockedRunIngest.mockReturnValue(ingestGate.promise);
    const reloadGate = deferred<StoriesResponse>();
    mockedFetchStories.mockReturnValueOnce(reloadGate.promise);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("250");
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("running");

    await act(async () => {
      ingestGate.resolve(sampleIngestResult);
      await ingestGate.promise;
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("refreshing");

    await act(async () => {
      reloadGate.resolve(sampleList);
      await reloadGate.promise;
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("done");
  });

  it("reaches ingest phase failed when the ingest POST rejects with a genuine error", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    mockedRunIngest.mockRejectedValueOnce(
      new ApiError({
        kind: "api",
        status: 500,
        code: "INTERNAL",
        message: "Something went wrong on the server.",
        url: "http://localhost:8000/api/ingest",
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });

    await waitFor(() => expect(screen.getByTestId("ingest-phase")).toHaveTextContent("failed"));
    expect(screen.getByTestId("ingest-error")).toHaveTextContent(
      "Something went wrong on the server.",
    );
  });

  it("a client-side timeout does NOT render as failed — the run continues server-side", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    const ingestGate = deferred<IngestResult>();
    mockedRunIngest.mockReturnValueOnce(ingestGate.promise);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("running");

    const timeoutError = new ApiError({
      kind: "network",
      code: "TIMEOUT",
      message: "The backend did not respond within 300s.",
      url: "http://localhost:8000/api/ingest",
    });
    await act(async () => {
      ingestGate.reject(timeoutError);
      await ingestGate.promise.catch(() => {});
    });

    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("timed_out");
    expect(screen.getByTestId("ingest-phase")).not.toHaveTextContent("failed");
    expect(screen.getByTestId("ingest-error")).toHaveTextContent("");
    expect(screen.getByTestId("ingest-message")).toHaveTextContent(/reload/i);
  });

  it("409 INGEST_IN_PROGRESS is a good-news phase, not a failure, and renders the server's message verbatim", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    const ingestGate = deferred<IngestResult>();
    mockedRunIngest.mockReturnValueOnce(ingestGate.promise);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("running");

    const inProgressError = new ApiError({
      kind: "api",
      status: 409,
      code: "INGEST_IN_PROGRESS",
      message: "A refresh is already running. Hang tight.",
      url: "http://localhost:8000/api/ingest",
    });
    await act(async () => {
      ingestGate.reject(inProgressError);
      await ingestGate.promise.catch(() => {});
    });

    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("in_progress");
    expect(screen.getByTestId("ingest-phase")).not.toHaveTextContent("failed");
    expect(screen.getByTestId("ingest-phase")).not.toHaveTextContent("done");
    expect(screen.getByTestId("ingest-error")).toHaveTextContent("");
    expect(screen.getByTestId("ingest-message")).toHaveTextContent(
      "A refresh is already running. Hang tight.",
    );
  });

  it("409 schedules exactly one reload of the story list after a short delay", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    // Fake timers only from here (same reasoning as the ticking test above):
    // the setTimeout for the delayed reload is scheduled inside the catch
    // branch below, so it must already be a fake timer when that runs.
    vi.useFakeTimers();

    const ingestGate = deferred<IngestResult>();
    mockedRunIngest.mockReturnValueOnce(ingestGate.promise);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });

    const inProgressError = new ApiError({
      kind: "api",
      status: 409,
      code: "INGEST_IN_PROGRESS",
      message: "A refresh is already running. Hang tight.",
      url: "http://localhost:8000/api/ingest",
    });
    await act(async () => {
      ingestGate.reject(inProgressError);
      await ingestGate.promise.catch(() => {});
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("in_progress");

    const reloadGate = deferred<StoriesResponse>();
    mockedFetchStories.mockReturnValueOnce(reloadGate.promise);
    const callsBeforeDelay = mockedFetchStories.mock.calls.length;

    // Nothing yet — the reload is delayed, not immediate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mockedFetchStories.mock.calls.length).toBe(callsBeforeDelay);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mockedFetchStories.mock.calls.length).toBe(callsBeforeDelay + 1);
  });

  it("429 INGEST_COOLDOWN is a good-news phase, not a failure, and renders the server's message verbatim", async () => {
    mockedFetchStories.mockResolvedValueOnce(sampleList);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    const ingestGate = deferred<IngestResult>();
    mockedRunIngest.mockReturnValueOnce(ingestGate.promise);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
    });
    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("running");

    const cooldownError = new ApiError({
      kind: "api",
      status: 429,
      code: "INGEST_COOLDOWN",
      message: "Already updated 3 minutes ago.",
      url: "http://localhost:8000/api/ingest",
      retryAfterSeconds: 720,
    });
    await act(async () => {
      ingestGate.reject(cooldownError);
      await ingestGate.promise.catch(() => {});
    });

    expect(screen.getByTestId("ingest-phase")).toHaveTextContent("cooldown");
    expect(screen.getByTestId("ingest-phase")).not.toHaveTextContent("failed");
    expect(screen.getByTestId("ingest-error")).toHaveTextContent("");
    expect(screen.getByTestId("ingest-message")).toHaveTextContent(
      "Already updated 3 minutes ago.",
    );
  });
});
