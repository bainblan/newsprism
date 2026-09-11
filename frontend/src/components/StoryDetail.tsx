"use client";

/**
 * A single cluster: the spread up top, then every source article grouped by
 * lean in fixed left -> right order.
 *
 * Empty lean groups are rendered rather than skipped. "Nobody on this side
 * covered it" is the most interesting thing this page can tell you, and it only
 * reads as an absence if the slot is visibly there.
 */

import Link from "next/link";

import { CoverageBar } from "@/components/CoverageBar";
import { SkewNote } from "@/components/SkewNote";
import { LEAN_META, LEAN_ORDER } from "@/lib/lean";
import { formatDateTime, formatHostname, formatRelativeTime } from "@/lib/format";
import type { Lean, SourceArticle, Story } from "@/lib/types";

function groupByLean(sources: SourceArticle[]): Record<Lean, SourceArticle[]> {
  // Written out rather than generated, so TypeScript enforces that every lean
  // in the enum has a bucket.
  const groups: Record<Lean, SourceArticle[]> = {
    left: [],
    lean_left: [],
    center: [],
    lean_right: [],
    right: [],
  };

  for (const source of sources) {
    // Defensive: the contract closes the enum, but an unexpected value should
    // drop one article rather than throw the page away.
    if (groups[source.lean]) groups[source.lean].push(source);
  }

  for (const lean of LEAN_ORDER) {
    groups[lean].sort(
      (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
    );
  }

  return groups;
}

export function StoryDetail({ story }: { story: Story }) {
  const groups = groupByLean(story.sources);

  return (
    <article>
      <Link
        href="/"
        className="text-xs text-muted underline underline-offset-4 hover:text-foreground"
      >
        &larr; All stories
      </Link>

      <header className="mt-5">
        <h1 className="max-w-[26ch] font-serif text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
          {story.title}
        </h1>

        {story.summary ? (
          <p className="mt-4 max-w-[62ch] text-lg leading-8 text-muted">
            {story.summary}
          </p>
        ) : null}

        <p className="mt-4 text-xs text-subtle tabular-nums">
          {story.article_count} source
          {story.article_count === 1 ? "" : "s"}
          <span aria-hidden="true"> · </span>
          last updated{" "}
          <time
            dateTime={story.updated_at}
            title={formatDateTime(story.updated_at)}
          >
            {formatRelativeTime(story.updated_at)}
          </time>
        </p>

        {story.archived ? (
          <p className="mt-2 text-xs text-subtle">
            Archived — this story&apos;s coverage has aged out, so it no
            longer appears in the list and won&apos;t gain new sources.
          </p>
        ) : null}
      </header>

      <section
        aria-label="Coverage spread"
        className="mt-8 rounded-lg border border-border bg-surface p-5 sm:p-6"
      >
        <SkewNote coverage={story.coverage} size="md" />
        <div className="mt-3">
          <CoverageBar coverage={story.coverage} size="lg" legend="full" />
        </div>
      </section>

      <section className="mt-10" aria-label="Source articles">
        <h2 className="text-xs font-medium tracking-wide text-subtle uppercase">
          Sources
        </h2>

        <div className="mt-4 space-y-8">
          {LEAN_ORDER.map((lean) => (
            <LeanGroup key={lean} lean={lean} articles={groups[lean]} />
          ))}
        </div>
      </section>
    </article>
  );
}

function LeanGroup({
  lean,
  articles,
}: {
  lean: Lean;
  articles: SourceArticle[];
}) {
  const meta = LEAN_META[lean];

  return (
    <section>
      <h3 className="flex items-baseline gap-2.5 border-b border-border pb-2">
        <span
          aria-hidden="true"
          className={`${meta.railClass} inline-block h-2.5 w-2.5 shrink-0 translate-y-[-1px] rounded-sm ${
            articles.length === 0 ? "opacity-30" : ""
          }`}
        />
        <span
          className={`text-sm font-medium ${
            articles.length === 0 ? "text-subtle" : "text-foreground"
          }`}
        >
          {meta.label}
        </span>
        <span className="text-xs text-subtle tabular-nums">
          {articles.length}
        </span>
      </h3>

      {articles.length === 0 ? (
        <p className="pt-3 text-sm text-subtle">
          No outlet on this side of the spectrum covered this story.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {articles.map((article) => (
            <li key={`${article.url}-${article.published_at}`} className="py-3.5">
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-serif text-base leading-snug font-medium text-balance hover:underline hover:underline-offset-4"
              >
                {article.title}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <p className="mt-1 text-xs text-subtle tabular-nums">
                <span className="text-muted">{article.outlet}</span>
                <span aria-hidden="true"> · </span>
                <time
                  dateTime={article.published_at}
                  title={formatDateTime(article.published_at)}
                >
                  {formatRelativeTime(article.published_at)}
                </time>
                {formatHostname(article.url) ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    {formatHostname(article.url)}
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
