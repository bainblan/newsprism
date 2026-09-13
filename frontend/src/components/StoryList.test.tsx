/**
 * components/StoryList.tsx — the populated-list header's ingest control.
 *
 * NEXT_PUBLIC_SHOW_INGEST_CONTROL was retired in contract v1.3 (the server now
 * bounds ingest work itself), so the control is unconditional. This confirms
 * it renders with no env var set at all.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoryList } from "@/components/StoryList";
import { useStories } from "@/components/StoriesProvider";
import { makeStory } from "@/test/fixtures";
import type { StoriesResponse } from "@/lib/types";

vi.mock("@/components/StoriesProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/StoriesProvider")>();
  return { ...actual, useStories: vi.fn() };
});

const mockedUseStories = vi.mocked(useStories);

const sampleData: StoriesResponse = {
  generated_at: "2026-09-10T00:00:00Z",
  stories: [makeStory()],
};

function idleContext(): ReturnType<typeof useStories> {
  return {
    state: { status: "ready", data: sampleData },
    isRefreshing: false,
    refresh: vi.fn(),
    ingest: {
      phase: "idle",
      elapsedMs: 0,
      result: null,
      error: null,
      message: null,
    },
    startIngest: vi.fn(),
    dismissIngest: vi.fn(),
    apiBaseUrl: "http://localhost:8000",
  };
}

describe("StoryList header", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the ingest control alongside Reload with no env var set", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<StoryList data={sampleData} />);

    expect(
      screen.getByRole("button", { name: /reload/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /update news/i }),
    ).toBeInTheDocument();
  });
});
