/**
 * lib/coverage.ts — every threshold in the product's central claim.
 *
 * Deliberately does not assert on LEAN_META label text (e.g. hardcoding the
 * word "Left") per docs/testing.md: that couples the test to copy that can
 * change on any redesign. Where a label is asserted at all, it is compared
 * against a value derived from the same lib/lean.ts the implementation uses,
 * not a hardcoded string.
 */

import { describe, expect, it } from "vitest";

import {
  blindspotLabel,
  coverageAriaLabel,
  coverageSegments,
  coverageTotal,
  describeSkew,
} from "@/lib/coverage";
import type { Coverage } from "@/lib/types";

function coverage(overrides: Partial<Coverage>): Coverage {
  return {
    left: 0,
    lean_left: 0,
    center: 0,
    lean_right: 0,
    right: 0,
    ...overrides,
  };
}

describe("coverageTotal", () => {
  it("sums all five buckets", () => {
    expect(coverageTotal(coverage({ left: 2, center: 3, right: 1 }))).toBe(6);
  });

  it("is 0 for an all-zero distribution", () => {
    expect(coverageTotal(coverage({}))).toBe(0);
  });
});

describe("describeSkew", () => {
  it("total === 0 produces tone 'none', not a share computed from a 0/0 division", () => {
    const skew = describeSkew(coverage({}));
    expect(skew.tone).toBe("none");
    expect(skew.blindspots).toEqual([]);
    expect(skew.label).toBe("No coverage");
  });

  it("one-sided threshold: exactly 0.8 left share is one-sided", () => {
    const skew = describeSkew(coverage({ left: 8, right: 2 }));
    expect(skew.tone).toBe("one-sided");
  });

  it("just under the one-sided threshold (0.79) is leaning, not one-sided", () => {
    const skew = describeSkew(coverage({ left: 79, right: 21 }));
    expect(skew.tone).toBe("leaning");
  });

  it("one-sided threshold applies symmetrically to the right", () => {
    const skew = describeSkew(coverage({ right: 8, left: 2 }));
    expect(skew.tone).toBe("one-sided");
  });

  it("leaning threshold: exactly 0.6 left share is leaning", () => {
    const skew = describeSkew(coverage({ left: 6, right: 4 }));
    expect(skew.tone).toBe("leaning");
  });

  it("just under the leaning threshold (0.5) is balanced", () => {
    const skew = describeSkew(coverage({ left: 5, right: 5 }));
    expect(skew.tone).toBe("balanced");
  });

  it("centered threshold: exactly 0.6 center share is centered", () => {
    const skew = describeSkew(coverage({ center: 6, left: 2, right: 2 }));
    expect(skew.tone).toBe("centered");
  });

  it("blind-spot floor: below 3 articles, a missing side is not reported", () => {
    const skew = describeSkew(coverage({ left: 1, right: 1 }));
    expect(skew.blindspots).toEqual([]);
  });

  it("blind-spot floor: at exactly 3 articles, a missing side is reported", () => {
    const skew = describeSkew(coverage({ left: 2, right: 1 }));
    expect(skew.blindspots).toContain("center");
  });

  it("reports every side with zero articles once the floor is met", () => {
    const skew = describeSkew(coverage({ left: 4 }));
    expect(skew.blindspots.sort()).toEqual(["center", "right"]);
  });
});

describe("blindspotLabel", () => {
  it("returns a distinct, non-empty label for each side", () => {
    const labels = (["left", "center", "right"] as const).map(blindspotLabel);
    expect(new Set(labels).size).toBe(3);
    labels.forEach((label) => expect(label.length).toBeGreaterThan(0));
  });
});

describe("coverageAriaLabel", () => {
  it("total === 0 produces a fixed, non-empty string (not NaN/Infinity anywhere)", () => {
    const label = coverageAriaLabel(coverage({}));
    expect(label).toBe("No source articles.");
  });

  it("carries the exact count and percent for every non-zero bucket", () => {
    const label = coverageAriaLabel(coverage({ left: 3, right: 1 }));
    expect(label).toContain("4 source article");
    expect(label).toMatch(/3 \(75%\)/);
    expect(label).toMatch(/1 \(25%\)/);
    expect(label).not.toMatch(/NaN|Infinity/);
  });

  it("names every zero bucket as missing, and omits the clause when nothing is missing", () => {
    const withGaps = coverageAriaLabel(coverage({ left: 1, right: 1 }));
    expect(withGaps).toMatch(/No coverage from/);

    const full = coverageAriaLabel(
      coverage({ left: 1, lean_left: 1, center: 1, lean_right: 1, right: 1 }),
    );
    expect(full).not.toMatch(/No coverage from/);
  });
});

describe("coverageSegments", () => {
  it("returns an empty array when total is 0", () => {
    expect(coverageSegments(coverage({}))).toEqual([]);
  });

  it("omits zero buckets and computes percent against the true total", () => {
    const segments = coverageSegments(coverage({ left: 1, right: 3 }));
    expect(segments).toHaveLength(2);
    const right = segments.find((segment) => segment.lean === "right");
    expect(right?.percent).toBe(75);
  });

  it("preserves fixed left-to-right order regardless of input key order", () => {
    const segments = coverageSegments(coverage({ right: 1, left: 1, center: 1 }));
    expect(segments.map((segment) => segment.lean)).toEqual(["left", "center", "right"]);
  });
});
