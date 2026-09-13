/**
 * components/StateViews.tsx — the non-story screens.
 *
 * NEXT_PUBLIC_SHOW_INGEST_CONTROL was retired in contract v1.3: the server now
 * bounds ingest work itself (single-flight lock + cooldown), so the button is
 * public and unconditional again. These tests confirm it renders with no env
 * var set at all — the deployed default is now "visible".
 *
 * Per docs/testing.md, these assert on roles/accessible names and visible
 * copy, never on Tailwind classes or LEAN_META strings.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyStoriesState, NoDataState } from "@/components/StateViews";
import { useStories } from "@/components/StoriesProvider";

vi.mock("@/components/StoriesProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/StoriesProvider")>();
  return { ...actual, useStories: vi.fn() };
});

const mockedUseStories = vi.mocked(useStories);

/** Enough of the context shape for these components; ingest starts idle. */
function idleContext(): ReturnType<typeof useStories> {
  return {
    state: { status: "no_data", message: "" },
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

describe("NoDataState", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the ingest button, the explanatory copy, and the NO_DATA diagnostic", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<NoDataState message="empty database" />);

    expect(
      screen.getByRole("button", { name: /get the news/i }),
    ).toBeInTheDocument();
    // Explains what the page does, that it refills on its own, AND that an
    // update can be requested now — both facts have to fit together.
    expect(
      screen.getByText(/groups the articles that describe the same event/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/refills on its own/i)).toBeInTheDocument();
    expect(screen.getByText(/every six hours/i)).toBeInTheDocument();
    expect(screen.getByText(/ask for an update now/i)).toBeInTheDocument();
    // The 503 diagnostic stays — it is useful and honest.
    expect(screen.getByText("503 NO_DATA")).toBeInTheDocument();
    expect(screen.getByText(/empty database/)).toBeInTheDocument();
  });
});

describe("EmptyStoriesState (sparse results)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows both Reload and the ingest button, and mentions both refill paths", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<EmptyStoriesState />);

    expect(
      screen.getByRole("button", { name: /reload/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /update news/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/refills automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/trigger an update now/i)).toBeInTheDocument();
  });
});
