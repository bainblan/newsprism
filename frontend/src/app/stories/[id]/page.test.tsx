/**
 * app/stories/[id]/page.tsx — slice 1.1's whole point.
 *
 * Covers: the list-hit path renders without ever calling fetchStory; the
 * list-miss path does call it; a 404 renders the not-found panel; and an
 * alias (the resolved `story.id` differs from the id in the URL) triggers
 * `router.replace`, never `router.push`.
 *
 * Mocks beyond `next/navigation` and `fetch` (per docs/testing.md's
 * pre-authorized failure mode): `@/lib/api`'s `fetchStory` and
 * `@/components/StoriesProvider`'s `useStories`, both swapped for `vi.fn()`
 * while keeping every other real export via `importOriginal`. `params` is a
 * Promise consumed with `use()`, so every render is wrapped in `<Suspense>`.
 */

import { Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StoryPage from "@/app/stories/[id]/page";
import { ApiError, fetchStory } from "@/lib/api";
import { useStories } from "@/components/StoriesProvider";
import { makeStory } from "@/test/fixtures";
import type { Story } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchStory: vi.fn() };
});

vi.mock("@/components/StoriesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/StoriesProvider")>();
  return { ...actual, useStories: vi.fn() };
});

const mockRouter = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

const mockedFetchStory = vi.mocked(fetchStory);
const mockedUseStories = vi.mocked(useStories);

/** The only branch these tests exercise: state.status === "ready". */
function readyWith(stories: Story[]): ReturnType<typeof useStories> {
  return {
    state: {
      status: "ready",
      data: { generated_at: "2026-09-11T00:00:00Z", stories },
    },
    isRefreshing: false,
    refresh: vi.fn(),
    ingest: { phase: "idle", elapsedMs: 0, result: null, error: null },
    startIngest: vi.fn(),
    dismissIngest: vi.fn(),
    apiBaseUrl: "http://localhost:8000",
  };
}

/** A promise plus its resolvers, so a test can control exactly when it settles. */
function deferredStory() {
  let resolve!: (value: Story) => void;
  const promise = new Promise<Story>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pageElement(id: string) {
  return (
    <Suspense fallback={<div>loading fallback</div>}>
      <StoryPage
        params={Promise.resolve({ id })}
        searchParams={Promise.resolve({})}
      />
    </Suspense>
  );
}

// `use(params)` suspends on first render even for an already-resolved
// Promise (its `.then` settles on a microtask), so the initial render has to
// happen inside an awaited `act` for React to flush past the Suspense
// boundary before assertions run.
async function renderPage(id: string) {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(pageElement(id));
  });
  return utils;
}

describe("StoryPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("list-hit: renders from the provider's list and never calls fetchStory", async () => {
    const story = makeStory({ id: "s_hit", title: "List hit story" });
    mockedUseStories.mockReturnValue(readyWith([story]));

    await renderPage("s_hit");

    expect(
      await screen.findByRole("heading", { name: "List hit story" }),
    ).toBeInTheDocument();
    expect(mockedFetchStory).not.toHaveBeenCalled();
  });

  it("list-miss: falls back to fetchStory when the list doesn't have the id", async () => {
    const story = makeStory({ id: "s_miss", title: "Fetched story" });
    mockedUseStories.mockReturnValue(readyWith([]));
    mockedFetchStory.mockResolvedValue(story);

    await renderPage("s_miss");

    expect(
      await screen.findByRole("heading", { name: "Fetched story" }),
    ).toBeInTheDocument();
    expect(mockedFetchStory).toHaveBeenCalledTimes(1);
    expect(mockedFetchStory).toHaveBeenCalledWith(
      "s_miss",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders the not-found panel on a 404", async () => {
    mockedUseStories.mockReturnValue(readyWith([]));
    mockedFetchStory.mockRejectedValue(
      new ApiError({
        kind: "api",
        status: 404,
        code: "NOT_FOUND",
        message: "no such story",
        url: "http://localhost:8000/api/stories/s_missing",
      }),
    );

    await renderPage("s_missing");

    expect(
      await screen.findByRole("heading", { name: /no story at this link/i }),
    ).toBeInTheDocument();
  });

  it("an alias (resolved story.id differs from the URL id) triggers router.replace, not push", async () => {
    const survivor = makeStory({ id: "s_survivor", title: "Survivor story" });
    mockedUseStories.mockReturnValue(readyWith([]));
    mockedFetchStory.mockResolvedValue(survivor);

    await renderPage("s_retired");

    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith("/stories/s_survivor", {
        scroll: false,
      }),
    );
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("a resolved fetch left over from a previous id never renders under the new id", async () => {
    // Both ids are list-misses, so each mount effect fetches directly.
    mockedUseStories.mockReturnValue(readyWith([]));

    const storyA = makeStory({ id: "s_a", title: "Story A" });
    const gateB = deferredStory();
    mockedFetchStory
      .mockResolvedValueOnce(storyA) // resolves for id "s_a" before the rerender
      .mockReturnValueOnce(gateB.promise); // pending for id "s_b" through the rerender

    const { rerender } = await renderPage("s_a");
    expect(
      await screen.findByRole("heading", { name: "Story A" }),
    ).toBeInTheDocument();

    // Navigate to a different id while its fetch is still pending. `detail`
    // state still holds Story A's resolved result at this point — the
    // `resolvedDetail` memo is what has to notice the id no longer matches.
    await act(async () => {
      rerender(pageElement("s_b"));
    });

    expect(
      screen.queryByRole("heading", { name: "Story A" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Loading story…")).toBeInTheDocument();

    await act(async () => {
      gateB.resolve(makeStory({ id: "s_b", title: "Story B" }));
      await gateB.promise;
    });

    expect(
      await screen.findByRole("heading", { name: "Story B" }),
    ).toBeInTheDocument();
  });
});
