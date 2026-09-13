/**
 * components/StoryList.tsx — the populated-list header's ingest control,
 * gated behind NEXT_PUBLIC_SHOW_INGEST_CONTROL (contract v1.2). Same mocking
 * approach as StateViews.test.tsx: `@/lib/config` mocked with a mutable
 * getter so both branches of the build-time flag are exercised in one file.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoryList } from "@/components/StoryList";
import { useStories } from "@/components/StoriesProvider";
import { makeStory } from "@/test/fixtures";
import type { StoriesResponse } from "@/lib/types";

const configState = vi.hoisted(() => ({ showIngestControl: false }));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    get SHOW_INGEST_CONTROL() {
      return configState.showIngestControl;
    },
  };
});

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
    ingest: { phase: "idle", elapsedMs: 0, result: null, error: null },
    startIngest: vi.fn(),
    dismissIngest: vi.fn(),
    apiBaseUrl: "http://localhost:8000",
  };
}

describe("StoryList header", () => {
  afterEach(() => {
    configState.showIngestControl = false;
    vi.clearAllMocks();
  });

  it("flag off (default): hides the ingest control, keeps Reload", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<StoryList data={sampleData} />);

    expect(
      screen.queryByRole("button", { name: /update news/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reload/i }),
    ).toBeInTheDocument();
  });

  it("flag on: shows the ingest control alongside Reload", () => {
    configState.showIngestControl = true;
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
