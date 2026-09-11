"use client";

/**
 * Story detail.
 *
 * INTERPRETATION OF THE CONTRACT (v1.1): ids are now durable — growing,
 * shrinking, merging, splitting, and aging out all resolve to something
 * renderable — but the list response is still windowed (`limit`, `min_sources`)
 * and can't answer for every id on its own. So this route tries the fast path
 * first: if the provider's list already has this id, its `sources` are
 * complete and fresh, and rendering it needs no request at all. Only when the
 * list doesn't have it does this route fall back to GET /api/stories/{id},
 * which is the endpoint that actually rescues a shared link — an aged-out
 * story, one that fell past the list's `limit`, or an id retired into another
 * story on a merge.
 *
 * A 200 from that lookup can carry a different `story.id` than the one in the
 * URL (an alias resolving to its survivor). There's no HTTP redirect for that
 * — the canonical id comes back in the body — so this route rewrites the
 * browser URL itself, without adding a history entry, once it notices the
 * mismatch.
 */

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { ApiError, fetchStory } from "@/lib/api";
import {
  FailedState,
  NoDataState,
  UnreachableState,
} from "@/components/StateViews";
import { StoryDetail } from "@/components/StoryDetail";
import { useStories } from "@/components/StoriesProvider";
import type { Story } from "@/lib/types";

/**
 * Every non-loading variant carries the id it resolved, so a render can tell
 * a stale result (left over from the previous id) from a current one without
 * an effect having to reset state to "loading" itself — see `resolvedDetail`
 * below.
 */
type DetailState =
  | { status: "loading" }
  | { status: "ready"; id: string; story: Story }
  | { status: "not_found"; id: string }
  /** 503 NO_DATA — reachable in principle if the DB was wiped mid-session. */
  | { status: "no_data"; id: string; message: string }
  | { status: "unreachable"; id: string; message: string; url: string }
  | {
      status: "failed";
      id: string;
      message: string;
      code?: string;
      httpStatus?: number;
    };

export default function StoryPage({ params }: PageProps<"/stories/[id]">) {
  const { id } = use(params);
  const { state } = useStories();
  const router = useRouter();

  const listStory =
    state.status === "ready"
      ? state.data.stories.find((candidate) => candidate.id === id)
      : undefined;

  // The list is authoritative when it has the id at all — no reason to
  // distrust or refetch it. The direct lookup only runs for the id the list
  // can't answer for.
  const shouldFetch = state.status === "ready" && !listStory;

  const [detail, setDetail] = useState<DetailState>({ status: "loading" });

  // Never a synchronous setState-to-"loading" at the top of the effect below:
  // a stale result (resolved for a previous id) is detected here, at render
  // time, by comparing the id it carries against the id currently on screen.
  const resolvedDetail: DetailState = useMemo(
    () =>
      detail.status !== "loading" && detail.id !== id
        ? { status: "loading" }
        : detail,
    [detail, id],
  );

  useEffect(() => {
    if (!shouldFetch) return;

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const story = await fetchStory(id, { signal: controller.signal });
        if (!cancelled) setDetail({ status: "ready", id, story });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError) {
          if (error.isNotFound) {
            setDetail({ status: "not_found", id });
          } else if (error.isNoData) {
            setDetail({ status: "no_data", id, message: error.message });
          } else if (error.kind === "network") {
            setDetail({
              status: "unreachable",
              id,
              message: error.message,
              url: error.url,
            });
          } else {
            setDetail({
              status: "failed",
              id,
              message: error.message,
              code: error.code,
              httpStatus: error.status,
            });
          }
        } else {
          setDetail({
            status: "failed",
            id,
            message:
              error instanceof Error
                ? error.message
                : "The app hit an unexpected error while loading this story.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldFetch, id]);

  // A retired id resolves to its survivor's body, not an HTTP redirect, so the
  // URL has to be fixed up here. `replace` (not `push`) so Back leaves the
  // page the user actually came from instead of the other spelling of this one.
  useEffect(() => {
    if (resolvedDetail.status === "ready" && resolvedDetail.story.id !== id) {
      router.replace(`/stories/${resolvedDetail.story.id}`, { scroll: false });
    }
  }, [resolvedDetail, id, router]);

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
      if (listStory) return <StoryDetail story={listStory} />;

      switch (resolvedDetail.status) {
        case "loading":
          return <StoryDetailSkeleton />;
        case "ready":
          return <StoryDetail story={resolvedDetail.story} />;
        case "not_found":
          return <StoryNotFound />;
        case "no_data":
          return <NoDataState message={resolvedDetail.message} />;
        case "unreachable":
          return (
            <UnreachableState
              message={resolvedDetail.message}
              url={resolvedDetail.url}
            />
          );
        case "failed":
          return (
            <FailedState
              message={resolvedDetail.message}
              code={resolvedDetail.code}
              httpStatus={resolvedDetail.httpStatus}
            />
          );
      }
    }
  }
}

function StoryNotFound() {
  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-border bg-surface px-6 py-8 sm:px-8 sm:py-10">
      <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
        There&apos;s no story at this link
      </h1>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-7 text-muted">
        <p>
          Story ids are durable — coverage growing, shrinking, merging, or
          aging out all resolve to something. This one simply isn&apos;t
          issued, or its story was removed outright.
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
