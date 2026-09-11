"use client";

/**
 * One clustered story in the list. The coverage bar sits in its own right-hand
 * column on wide screens so the spreads line up vertically and the eye can
 * compare them down the page; it stacks under the text on narrow screens.
 */

import Link from "next/link";

import { CoverageBar } from "@/components/CoverageBar";
import { SkewNote } from "@/components/SkewNote";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { Story } from "@/lib/types";

export function StoryCard({ story }: { story: Story }) {
  return (
    <article className="relative border-b border-border py-7 last:border-b-0">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-10">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl leading-snug font-semibold tracking-tight text-balance sm:text-[1.375rem]">
            {/* Stretched link: the whole card is clickable, but the accessible
                name of the link is just the headline. */}
            <Link
              href={`/stories/${encodeURIComponent(story.id)}`}
              className="after:absolute after:inset-0 hover:underline hover:decoration-border-strong hover:underline-offset-4"
            >
              {story.title}
            </Link>
          </h2>

          {story.summary ? (
            <p className="mt-2 max-w-[62ch] text-[0.9375rem] leading-7 text-muted line-clamp-3">
              {story.summary}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-subtle tabular-nums">
            {story.article_count} source
            {story.article_count === 1 ? "" : "s"}
            <span aria-hidden="true"> · </span>
            <time
              dateTime={story.updated_at}
              title={formatDateTime(story.updated_at)}
            >
              {formatRelativeTime(story.updated_at)}
            </time>
          </p>
        </div>

        <div className="w-full shrink-0 sm:w-56">
          <SkewNote coverage={story.coverage} />
          <div className="mt-2">
            <CoverageBar coverage={story.coverage} size="sm" legend="compact" />
          </div>
        </div>
      </div>
    </article>
  );
}
