/**
 * Shared story fixtures for tests. Not itself a test file — a single obvious
 * place for the fabricated data multiple suites need, mirroring
 * docs/api-contract.md shapes exactly (see src/lib/mock/mock-api.ts, which
 * this deliberately does not import from: that module is production-shipped
 * mock data behind NEXT_PUBLIC_USE_MOCK_DATA, this is test-only and never
 * bundled).
 */

import type { Coverage, SourceArticle, Story } from "@/lib/types";

export function makeCoverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    left: 0,
    lean_left: 0,
    center: 0,
    lean_right: 0,
    right: 0,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<SourceArticle> = {}): SourceArticle {
  return {
    outlet: "Example Outlet",
    lean: "center",
    title: "Example headline",
    url: "https://example.com/article",
    published_at: "2026-09-10T12:00:00Z",
    ...overrides,
  };
}

export function makeStory(overrides: Partial<Story> = {}): Story {
  const sources = overrides.sources ?? [
    makeSource({ outlet: "Left Outlet", lean: "left" }),
    makeSource({ outlet: "Right Outlet", lean: "right" }),
  ];
  return {
    id: "s_000000000001",
    title: "Example story",
    summary: "An example story summary.",
    updated_at: "2026-09-10T12:00:00Z",
    archived: false,
    article_count: sources.length,
    coverage: makeCoverage({ left: 1, right: 1 }),
    sources,
    ...overrides,
  };
}
