/**
 * components/StateViews.tsx — the ingest-control gating added when
 * POST /api/ingest went behind a shared secret (contract v1.2).
 * NEXT_PUBLIC_SHOW_INGEST_CONTROL is a build-time constant baked into
 * `@/lib/config`'s `SHOW_INGEST_CONTROL`, so both branches are exercised here
 * by mocking that module with a mutable getter (`vi.hoisted`) rather than by
 * touching `process.env` at runtime — config.ts's literal-property-access
 * comment is about Next's build-time inlining, not this mock.
 *
 * Per docs/testing.md, these assert on roles/accessible names and visible
 * copy, never on Tailwind classes or LEAN_META strings.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyStoriesState, NoDataState } from "@/components/StateViews";
import { useStories } from "@/components/StoriesProvider";

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

/** Enough of the context shape for these components; ingest starts idle. */
function idleContext(): ReturnType<typeof useStories> {
  return {
    state: { status: "no_data", message: "" },
    isRefreshing: false,
    refresh: vi.fn(),
    ingest: { phase: "idle", elapsedMs: 0, result: null, error: null },
    startIngest: vi.fn(),
    dismissIngest: vi.fn(),
    apiBaseUrl: "http://localhost:8000",
  };
}

describe("NoDataState", () => {
  afterEach(() => {
    configState.showIngestControl = false;
    vi.clearAllMocks();
  });

  it("flag off (default): hides the ingest button but keeps the explanatory copy and the NO_DATA diagnostic", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<NoDataState message="empty database" />);

    expect(
      screen.queryByRole("button", { name: /get the news/i }),
    ).not.toBeInTheDocument();
    // Explains what the page does and that it refills on its own — not
    // instructions for an action the reader cannot take.
    expect(
      screen.getByText(/groups the articles that describe the same event/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/refills on its own/i)).toBeInTheDocument();
    expect(screen.getByText(/every six hours/i)).toBeInTheDocument();
    // The 503 diagnostic stays — it is useful and honest.
    expect(screen.getByText("503 NO_DATA")).toBeInTheDocument();
    expect(screen.getByText(/empty database/)).toBeInTheDocument();
  });

  it("flag on: shows the ingest button and the local-run copy", () => {
    configState.showIngestControl = true;
    mockedUseStories.mockReturnValue(idleContext());
    render(<NoDataState message="empty database" />);

    expect(
      screen.getByRole("button", { name: /get the news/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/30 to 60 seconds/i)).toBeInTheDocument();
  });
});

describe("EmptyStoriesState (sparse results)", () => {
  afterEach(() => {
    configState.showIngestControl = false;
    vi.clearAllMocks();
  });

  it("flag off (default): hides the ingest button, keeps Reload", () => {
    mockedUseStories.mockReturnValue(idleContext());
    render(<EmptyStoriesState />);

    expect(
      screen.queryByRole("button", { name: /update news/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reload/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/refills automatically/i)).toBeInTheDocument();
  });

  it("flag on: shows both Reload and the ingest button", () => {
    configState.showIngestControl = true;
    mockedUseStories.mockReturnValue(idleContext());
    render(<EmptyStoriesState />);

    expect(
      screen.getByRole("button", { name: /reload/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /update news/i }),
    ).toBeInTheDocument();
  });
});
