"use client";

/**
 * Story detail.
 *
 * INTERPRETATION OF THE CONTRACT: there is no GET /api/stories/{id} in v1. The
 * contract instead guarantees that `sources` on the list response contains
 * every article in the cluster, explicitly "so the frontend can render the
 * detail view without a second request". So this route selects out of the same
 * list response the home page uses, and on a cold deep link it runs the same
 * fetch and therefore the same loading / NO_DATA / unreachable states.
 *
 * The consequence worth knowing: a story whose id is not in the current list
 * response cannot be rendered at all. That happens when an id is stale (a new
 * ingest re-clustered the articles) or when it falls outside the list's limit.
 * Both are handled as a not-found panel rather than a crash.
 */

import { use } from "react";
import Link from "next/link";

import {
  FailedState,
  NoDataState,
  UnreachableState,
} from "@/components/StateViews";
import { StoryDetail } from "@/components/StoryDetail";
import { useStories } from "@/components/StoriesProvider";

export default function StoryPage({ params }: PageProps<"/stories/[id]">) {
  const { id } = use(params);
  const { state } = useStories();

  switch (state.status) {
    case "loading":
      return <StoryDetailSkeleton />;

    case "no_data":
      return <NoDataState message={state.message} />;

    case "unreachable":
      return <UnreachableState message={state.message} url={state.url} />;

    case "failed":
      return (
        <FailedState
          message={state.message}
          code={state.code}
          httpStatus={state.httpStatus}
        />
      );

    case "ready": {
      const story = state.data.stories.find((candidate) => candidate.id === id);
      return story ? <StoryDetail story={story} /> : <StoryNotFound />;
    }
  }
}

function StoryNotFound() {
  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-border bg-surface px-6 py-8 sm:px-8 sm:py-10">
      <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
        That story is no longer in the list
      </h1>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-7 text-muted">
        <p>
          Cluster ids are not permanent. Each ingest run regroups the articles,
          so a link saved earlier can point at a cluster that no longer exists
          under that id — or at one that has since dropped off the end of the
          list.
        </p>
        <p>
          <Link
            href="/"
            className="text-foreground underline underline-offset-4"
          >
            Back to all stories
          </Link>
        </p>
      </div>
    </section>
  );
}

function StoryDetailSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-3 w-24 rounded bg-surface-muted" />
      <div className="mt-6 space-y-3">
        <div className="h-8 w-4/5 rounded bg-surface-muted" />
        <div className="h-8 w-3/5 rounded bg-surface-muted" />
      </div>
      <div className="mt-6 space-y-2">
        <div className="h-4 w-full max-w-[62ch] rounded bg-surface-muted" />
        <div className="h-4 w-full max-w-[52ch] rounded bg-surface-muted" />
      </div>
      <div className="mt-8 h-28 rounded-lg bg-surface-muted" />
      <div className="mt-10 space-y-6">
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-3">
            <div className="h-3 w-28 rounded bg-surface-muted" />
            <div className="h-4 w-3/4 rounded bg-surface-muted" />
            <div className="h-4 w-2/3 rounded bg-surface-muted" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading story…</span>
    </div>
  );
}
