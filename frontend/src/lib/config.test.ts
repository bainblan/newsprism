/**
 * lib/config.ts — SHOW_INGEST_CONTROL's exact string comparison.
 *
 * This is the one thing StateViews.test.tsx and StoryList.test.tsx cannot
 * exercise: those mock `@/lib/config` wholesale (needed to toggle the flag
 * without an env var set at import time), which means a broken comparison in
 * config.ts itself — e.g. `!== "false"` instead of `=== "true"`, which flips
 * the safe default — would pass every component test untouched. Per
 * docs/testing.md, the env var is set with `vi.stubEnv` before a fresh
 * `import()` (module cache reset via `vi.resetModules`) rather than by making
 * config.ts's literal property access dynamic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadShowIngestControl() {
  vi.resetModules();
  const mod = await import("@/lib/config");
  return mod.SHOW_INGEST_CONTROL;
}

describe("SHOW_INGEST_CONTROL", () => {
  it("is false when unset — the safe default for a deployed instance", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_INGEST_CONTROL", undefined as unknown as string);
    expect(await loadShowIngestControl()).toBe(false);
  });

  it("is false for any value other than the exact string 'true'", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_INGEST_CONTROL", "false");
    expect(await loadShowIngestControl()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_SHOW_INGEST_CONTROL", "1");
    expect(await loadShowIngestControl()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_SHOW_INGEST_CONTROL", "True");
    expect(await loadShowIngestControl()).toBe(false);
  });

  it("is true only for the exact string 'true'", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_INGEST_CONTROL", "true");
    expect(await loadShowIngestControl()).toBe(true);
  });
});
