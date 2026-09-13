/**
 * components/IngestAction.tsx — the button plus its five terminal readouts.
 *
 * `done` and `failed` are pre-existing; `in_progress` (409), `cooldown` (429)
 * and `timed_out` (client-side timeout) are new in contract v1.3 and must
 * render as good news / neutral information, never through the failure path.
 * Per docs/testing.md, these assert on roles/accessible names and visible
 * copy, never on Tailwind classes.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IngestAction } from "@/components/IngestAction";
import { useStories } from "@/components/StoriesProvider";
import type { IngestState } from "@/components/StoriesProvider";
import type { IngestResult } from "@/lib/types";

vi.mock("@/components/StoriesProvider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/StoriesProvider")>();
  return { ...actual, useStories: vi.fn() };
});

const mockedUseStories = vi.mocked(useStories);

function contextWith(ingest: IngestState): ReturnType<typeof useStories> {
  return {
    state: { status: "ready", data: { generated_at: "2026-09-10T00:00:00Z", stories: [] } },
    isRefreshing: false,
    refresh: vi.fn(),
    ingest,
    startIngest: vi.fn(),
    dismissIngest: vi.fn(),
    apiBaseUrl: "http://localhost:8000",
  };
}

const sampleResult: IngestResult = {
  feeds_attempted: 18,
  feeds_succeeded: 17,
  feeds_failed: [],
  articles_ingested: 500,
  articles_new: 40,
  clusters_formed: 46,
  duration_seconds: 42.5,
};

describe("IngestAction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("idle: renders the button with the given idle label, no Dismiss", () => {
    mockedUseStories.mockReturnValue(
      contextWith({ phase: "idle", elapsedMs: 0, result: null, error: null, message: null }),
    );
    render(<IngestAction idleLabel="Update news" />);

    expect(screen.getByRole("button", { name: "Update news" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("running: button is busy/disabled and shows progress", () => {
    mockedUseStories.mockReturnValue(
      contextWith({ phase: "running", elapsedMs: 1000, result: null, error: null, message: null }),
    );
    render(<IngestAction idleLabel="Update news" />);

    const button = screen.getByRole("button", { name: /updating/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("done: shows the run summary, not a failure panel", () => {
    mockedUseStories.mockReturnValue(
      contextWith({ phase: "done", elapsedMs: 42_500, result: sampleResult, error: null, message: null }),
    );
    render(<IngestAction idleLabel="Update news" />);

    expect(screen.getByText(/ingest complete/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("409 in_progress: renders as a status, not a failure, showing the server's message verbatim", () => {
    mockedUseStories.mockReturnValue(
      contextWith({
        phase: "in_progress",
        elapsedMs: 0,
        result: null,
        error: null,
        message: "A refresh is already running. Hang tight.",
      }),
    );
    render(<IngestAction idleLabel="Update news" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("A refresh is already running. Hang tight.");
    expect(screen.queryByText(/ingest failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
    // The idle button must still be usable (not stuck disabled) once the
    // in-flight run is someone else's, not this tab's.
    expect(screen.getByRole("button", { name: "Update news" })).toBeEnabled();
  });

  it("429 cooldown: renders as a status, not a failure, showing the server's message verbatim", () => {
    mockedUseStories.mockReturnValue(
      contextWith({
        phase: "cooldown",
        elapsedMs: 0,
        result: null,
        error: null,
        message: "Already updated 3 minutes ago.",
      }),
    );
    render(<IngestAction idleLabel="Update news" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Already updated 3 minutes ago.");
    expect(screen.queryByText(/ingest failed/i)).not.toBeInTheDocument();
  });

  it("timed_out: renders as a status, not a failure", () => {
    mockedUseStories.mockReturnValue(
      contextWith({
        phase: "timed_out",
        elapsedMs: 300_000,
        result: null,
        error: null,
        message: "No response yet, but the run keeps going on the server.",
      }),
    );
    render(<IngestAction idleLabel="Update news" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/keeps going/i);
    expect(screen.queryByText(/ingest failed/i)).not.toBeInTheDocument();
  });

  it("failed: renders the failure panel with the error message and a retry", () => {
    mockedUseStories.mockReturnValue(
      contextWith({
        phase: "failed",
        elapsedMs: 0,
        result: null,
        error: "Something went wrong on the server.",
        message: null,
      }),
    );
    render(<IngestAction idleLabel="Update news" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/ingest failed/i);
    expect(alert).toHaveTextContent("Something went wrong on the server.");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
