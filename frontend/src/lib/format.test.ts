/**
 * lib/format.ts — boundary arithmetic and invalid-input fallbacks.
 */

import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateTime,
  formatElapsed,
  formatHostname,
  formatRelativeTime,
} from "@/lib/format";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");

  it("invalid input returns \"\"", () => {
    expect(formatRelativeTime("not a date", now)).toBe("");
  });

  it("under 60s reads 'just now'", () => {
    const then = new Date(now - 30_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("just now");
  });

  it("at exactly 60s crosses into minutes", () => {
    const then = new Date(now - 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("1 min ago");
  });

  it("at exactly 60 minutes crosses into hours", () => {
    const then = new Date(now - 60 * 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("1 hr ago");
  });

  it("at exactly 24 hours crosses into days, singular", () => {
    const then = new Date(now - 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("1 day ago");
  });

  it("pluralises days", () => {
    const then = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("2 days ago");
  });

  it("falls back to the absolute date past 7 days", () => {
    const then = new Date(now - 8 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe(formatDate(then));
  });

  it("at exactly 7 days is still relative, not the absolute fallback", () => {
    const then = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(then, now)).toBe("7 days ago");
  });
});

describe("formatDate", () => {
  it("invalid input returns \"\"", () => {
    expect(formatDate("not a date")).toBe("");
  });

  it("valid input returns a non-empty string", () => {
    expect(formatDate("2026-09-10T12:00:00Z").length).toBeGreaterThan(0);
  });
});

describe("formatDateTime", () => {
  it("invalid input returns \"\"", () => {
    expect(formatDateTime("not a date")).toBe("");
  });

  it("valid input returns a non-empty string", () => {
    expect(formatDateTime("2026-09-10T12:00:00Z").length).toBeGreaterThan(0);
  });
});

describe("formatElapsed", () => {
  it("clamps negative input to 0:00", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
  });

  it("zero is 0:00", () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  it("pads single-digit seconds", () => {
    expect(formatElapsed(42_000)).toBe("0:42");
  });

  it("rolls seconds into minutes at exactly 60s", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
  });

  it("formats multi-minute durations", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
  });

  it("truncates rather than rounds partial seconds", () => {
    expect(formatElapsed(1_999)).toBe("0:01");
  });
});

describe("formatHostname", () => {
  it("strips a leading www.", () => {
    expect(formatHostname("https://www.reuters.com/article/123")).toBe("reuters.com");
  });

  it("leaves a hostname with no www. alone", () => {
    expect(formatHostname("https://apnews.com/article/123")).toBe("apnews.com");
  });

  it("invalid input returns \"\"", () => {
    expect(formatHostname("not a url")).toBe("");
  });
});
