"use client";

/**
 * The non-story screens. None of these is a throwaway: on a fresh clone the
 * NO_DATA panel is the first thing anyone sees, and the unreachable panel is
 * what a developer sees every time the backend is not running.
 */

import { IngestAction } from "@/components/IngestAction";
import { useStories } from "@/components/StoriesProvider";
import { USE_MOCK_DATA } from "@/lib/config";

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-border bg-surface px-6 py-8 sm:px-8 sm:py-10">
      <h2 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-7 text-muted">
        {children}
      </div>
    </section>
  );
}

/**
 * 503 NO_DATA. The database is empty because ingest has never run — which is
 * the expected state of a fresh checkout, so this reads as an onboarding step
 * rather than a failure.
 */
export function NoDataState({ message }: { message: string }) {
  return (
    <Panel title="No stories yet">
      <p>
        Newsprism reads the front page of around twenty news outlets across the
        political spectrum, groups the articles that describe the same event,
        and works out how each story&apos;s coverage is distributed. Nothing has
        been ingested yet, so there is nothing to show.
      </p>
      <p>
        This refills on its own roughly every six hours, or you can ask for an
        update now — a run takes a few minutes on the live server, since it is
        waiting on around twenty news sites rather than anything local.
      </p>
      <div className="pt-2">
        <IngestAction tone="primary" idleLabel="Get the news" />
      </div>
      <p className="border-t border-border pt-4 text-xs text-subtle">
        Backend reported <code className="font-mono">503 NO_DATA</code>
        {message ? `: ${message}` : "."}
      </p>
    </Panel>
  );
}

/**
 * No HTTP response at all. Distinct from a backend error, because the fix is
 * different: start the server, or point the frontend somewhere else.
 */
export function UnreachableState({
  message,
  url,
}: {
  message: string;
  url: string;
}) {
  const { refresh, isRefreshing, apiBaseUrl } = useStories();

  return (
    <Panel title="Can’t reach the backend">
      <p>
        {message} Nothing answered at{" "}
        <code className="font-mono text-sm break-all text-foreground">{url}</code>.
      </p>
      <p>Usually one of these:</p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          The API is not running. Start it with{" "}
          <code className="font-mono text-sm text-foreground">
            uvicorn app.main:app --reload --port 8000
          </code>{" "}
          from the <code className="font-mono text-sm">backend/</code> directory.
        </li>
        <li>
          It is running somewhere else. This build is pointed at{" "}
          <code className="font-mono text-sm break-all text-foreground">
            {apiBaseUrl}
          </code>{" "}
          — set <code className="font-mono text-sm">NEXT_PUBLIC_API_URL</code> in{" "}
          <code className="font-mono text-sm">frontend/.env.local</code> and
          restart the dev server to change it.
        </li>
        <li>
          The request was blocked by CORS. The API has to allow the origin{" "}
          <code className="font-mono text-sm text-foreground">
            http://localhost:3000
          </code>
          . A CORS rejection looks identical to a dead server from in here, so
          check the browser console for the specific complaint.
        </li>
      </ul>
      <div className="pt-2">
        <button
          type="button"
          onClick={refresh}
          disabled={isRefreshing}
          className="inline-flex items-center rounded-md border border-border-strong px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-60"
        >
          {isRefreshing ? "Retrying…" : "Retry"}
        </button>
      </div>
      {!USE_MOCK_DATA ? (
        <p className="border-t border-border pt-4 text-xs text-subtle">
          Building UI without a backend? Set{" "}
          <code className="font-mono">NEXT_PUBLIC_USE_MOCK_DATA=true</code> to
          render the interface against local fixtures.
        </p>
      ) : null}
    </Panel>
  );
}

/** Any other non-2xx, rendered from the contract's error envelope. */
export function FailedState({
  message,
  code,
  httpStatus,
}: {
  message: string;
  code?: string;
  httpStatus?: number;
}) {
  const { refresh, isRefreshing } = useStories();

  return (
    <Panel title="The backend returned an error">
      <p>{message}</p>
      <div className="pt-2">
        <button
          type="button"
          onClick={refresh}
          disabled={isRefreshing}
          className="inline-flex items-center rounded-md border border-border-strong px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-60"
        >
          {isRefreshing ? "Retrying…" : "Retry"}
        </button>
      </div>
      <p className="border-t border-border pt-4 text-xs text-subtle">
        <code className="font-mono">
          {httpStatus ?? "—"} {code ?? "UNKNOWN"}
        </code>
      </p>
    </Panel>
  );
}

/**
 * A 200 with an empty `stories` array. Valid per the contract, so this is a
 * neutral screen — but it is worth saying why it can happen.
 */
export function EmptyStoriesState() {
  const { refresh, isRefreshing } = useStories();

  return (
    <Panel title="Nothing clustered yet">
      <p>
        The backend answered, but no story had coverage from at least two
        outlets. A single-outlet story has no spread to compare, so it is left
        out.
      </p>
      <p>
        That usually means the last ingest run pulled very little — either it
        has only run once, or most feeds failed. This refills automatically
        roughly every six hours, or you can trigger an update now.
      </p>
      <div className="flex flex-wrap items-start gap-3 pt-2">
        <button
          type="button"
          onClick={refresh}
          disabled={isRefreshing}
          className="inline-flex items-center rounded-md border border-border-strong px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-60"
        >
          {isRefreshing ? "Reloading…" : "Reload"}
        </button>
      </div>
      <div className="pt-1">
        <IngestAction tone="primary" idleLabel="Update news" />
      </div>
    </Panel>
  );
}

/** Shown on first load only. Mirrors the shape of a story card. */
export function StoryListSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="flex flex-col gap-5 border-b border-border py-7 last:border-b-0 sm:flex-row sm:gap-10"
        >
          <div className="min-w-0 flex-1 space-y-3">
            <div className="h-5 w-4/5 rounded bg-surface-muted" />
            <div className="h-3 w-full rounded bg-surface-muted" />
            <div className="h-3 w-11/12 rounded bg-surface-muted" />
            <div className="h-3 w-24 rounded bg-surface-muted" />
          </div>
          <div className="w-full shrink-0 space-y-2 sm:w-56">
            <div className="h-3 w-40 rounded bg-surface-muted" />
            <div className="h-2 w-full rounded-full bg-surface-muted" />
            <div className="h-3 w-32 rounded bg-surface-muted" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading stories…</span>
    </div>
  );
}
