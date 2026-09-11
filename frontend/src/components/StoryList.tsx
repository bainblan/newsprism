"use client";

/**
 * The populated list: a toolbar with the data's age and the refresh/ingest
 * actions, the spectrum key, then the cards.
 *
 * The ingest control gets its own row rather than sitting inline, because it
 * expands into a progress readout and a run summary and would otherwise shove
 * the rest of the toolbar around mid-run.
 */

import { IngestAction } from "@/components/IngestAction";
import { SpectrumKey } from "@/components/SpectrumKey";
import { StoryCard } from "@/components/StoryCard";
import { useStories } from "@/components/StoriesProvider";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { StoriesResponse } from "@/lib/types";

export function StoryList({ data }: { data: StoriesResponse }) {
  const { refresh, isRefreshing } = useStories();

  return (
    <div>
      <div className="border-b border-border pb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <p className="text-xs text-subtle tabular-nums">
            {data.stories.length} stor{data.stories.length === 1 ? "y" : "ies"}
            <span aria-hidden="true"> · </span>
            updated{" "}
            <time
              dateTime={data.generated_at}
              title={formatDateTime(data.generated_at)}
            >
              {formatRelativeTime(data.generated_at)}
            </time>
          </p>

          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            className="text-xs text-muted underline underline-offset-4 hover:text-foreground disabled:opacity-60"
          >
            {isRefreshing ? "Reloading…" : "Reload"}
          </button>
        </div>

        <div className="mt-4">
          <IngestAction tone="secondary" idleLabel="Run ingest" />
        </div>
      </div>

      <div className="border-b border-border py-4">
        <SpectrumKey />
      </div>

      <div>
        {data.stories.map((story) => (
          <StoryCard key={story.id} story={story} />
        ))}
      </div>
    </div>
  );
}
