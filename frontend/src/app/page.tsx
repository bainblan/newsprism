"use client";

/**
 * Story list. Every branch below is a state a real user hits — a cold clone
 * lands on `no_data`, and a dev without the API running lands on `unreachable`.
 */

import {
  EmptyStoriesState,
  FailedState,
  NoDataState,
  StoryListSkeleton,
  UnreachableState,
} from "@/components/StateViews";
import { StoryList } from "@/components/StoryList";
import { useStories } from "@/components/StoriesProvider";

export default function HomePage() {
  const { state } = useStories();

  switch (state.status) {
    case "loading":
      return <StoryListSkeleton />;

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

    case "ready":
      return state.data.stories.length === 0 ? (
        <EmptyStoriesState />
      ) : (
        <StoryList data={state.data} />
      );
  }
}
