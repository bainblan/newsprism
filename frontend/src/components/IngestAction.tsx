"use client";

/**
 * Trigger and live readout for POST /api/ingest.
 *
 * The contract says this call is synchronous and may take 30-60 seconds, so a
 * plain disabled button would look like a hang. The progress here is honest:
 * the number shown is real elapsed wall-clock time, and the bar is explicitly
 * labelled as elapsed time measured against the contract's expected window,
 * not a fabricated completion percentage. Once it passes the window it says so
 * rather than sitting at 99%.
 */

import { useStories } from "@/components/StoriesProvider";
import { INGEST_EXPECTED_SECONDS } from "@/lib/config";
import { formatElapsed } from "@/lib/format";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed";

const buttonTone = {
  primary:
    "bg-foreground text-background hover:opacity-90 disabled:opacity-60",
  secondary:
    "border border-border-strong text-foreground hover:bg-surface-muted disabled:opacity-60",
} as const;

export function IngestAction({
  tone = "primary",
  idleLabel = "Update news",
}: {
  tone?: keyof typeof buttonTone;
  idleLabel?: string;
}) {
  const { ingest, startIngest, dismissIngest } = useStories();
  const busy = ingest.phase === "running" || ingest.phase === "refreshing";

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={startIngest}
          disabled={busy}
          aria-busy={busy}
          className={`${buttonBase} ${buttonTone[tone]}`}
        >
          {busy ? <Spinner /> : null}
          {busy ? "Updating…" : idleLabel}
        </button>

        {ingest.phase === "done" || ingest.phase === "failed" ? (
          <button
            type="button"
            onClick={dismissIngest}
            className="text-sm text-muted underline underline-offset-4 hover:text-foreground"
          >
            Dismiss
          </button>
        ) : null}
      </div>

      {busy ? <IngestProgress /> : null}
      {ingest.phase === "done" && ingest.result ? (
        <IngestSummary />
      ) : null}
      {ingest.phase === "failed" ? <IngestFailure /> : null}
    </div>
  );
}

function IngestProgress() {
  const { ingest } = useStories();
  const elapsedSeconds = ingest.elapsedMs / 1000;
  const overdue = elapsedSeconds > INGEST_EXPECTED_SECONDS.max;

  // Fraction of the contract's expected window that has elapsed. Capped below
  // 1 so the bar never claims to be finished while the request is still open.
  const fraction =
    ingest.phase === "refreshing"
      ? 0.96
      : Math.min(elapsedSeconds / INGEST_EXPECTED_SECONDS.max, 0.92);

  const status =
    ingest.phase === "refreshing"
      ? "Ingest finished. Reloading stories…"
      : overdue
        ? "Taking longer than usual — the run is still open."
        : "Fetching feeds, then clustering articles.";

  return (
    <div className="mt-4 max-w-md">
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-label="Ingest progress, measured as elapsed time"
        aria-valuetext={`${Math.round(elapsedSeconds)} seconds elapsed`}
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-linear"
          style={{ width: `${fraction * 100}%` }}
        />
        {/* Liveness cue: keeps moving even when the width barely changes. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1/4">
          <div className="animate-sweep h-full w-full bg-linear-to-r from-transparent via-border-strong to-transparent opacity-70" />
        </div>
      </div>

      <p className="mt-2 text-xs text-muted tabular-nums" aria-live="polite">
        <span className="font-medium text-foreground">
          {formatElapsed(ingest.elapsedMs)} elapsed
        </span>
        <span aria-hidden="true"> · </span>
        {status}
      </p>
      <p className="mt-1 text-xs text-subtle">
        Typically {INGEST_EXPECTED_SECONDS.min}–{INGEST_EXPECTED_SECONDS.max}{" "}
        seconds. The run continues on the backend even if you navigate away.
      </p>
    </div>
  );
}

function IngestSummary() {
  const { ingest } = useStories();
  const result = ingest.result;
  if (!result) return null;

  return (
    <div className="mt-4 max-w-2xl rounded-md border border-border bg-surface-muted p-4">
      <p className="text-sm text-foreground">
        Ingest complete in {result.duration_seconds.toFixed(1)}s —{" "}
        <span className="tabular-nums">{result.articles_new}</span> new article
        {result.articles_new === 1 ? "" : "s"} from{" "}
        <span className="tabular-nums">{result.articles_ingested}</span> fetched,
        forming <span className="tabular-nums">{result.clusters_formed}</span>{" "}
        cluster{result.clusters_formed === 1 ? "" : "s"}.
      </p>
      <p className="mt-1 text-xs text-muted tabular-nums">
        {result.feeds_succeeded} of {result.feeds_attempted} feeds succeeded.
      </p>

      {result.feeds_failed.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
            {result.feeds_failed.length} feed
            {result.feeds_failed.length === 1 ? "" : "s"} failed
          </summary>
          {/* Surfaced rather than swallowed: a dead feed at one end of the
              spectrum quietly skews every bar in the app. */}
          <ul className="mt-2 space-y-1">
            {result.feeds_failed.map((feed) => (
              <li key={feed} className="font-mono text-[0.6875rem] break-all text-subtle">
                {feed}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function IngestFailure() {
  const { ingest, startIngest } = useStories();

  return (
    <div className="mt-4 max-w-2xl rounded-md border border-border bg-surface-muted p-4">
      <p className="text-sm font-medium text-foreground">Ingest failed</p>
      <p className="mt-1 text-sm text-muted">{ingest.error}</p>
      <button
        type="button"
        onClick={startIngest}
        className="mt-3 text-sm text-foreground underline underline-offset-4"
      >
        Try again
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
