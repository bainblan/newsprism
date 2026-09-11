/**
 * components/CoverageBar.tsx — that the aria-label carries the same
 * distribution the colours do (the accessibility promise in lib/lean.ts made
 * checkable). Deliberately does not assert on Tailwind classes or LEAN_META
 * label text per docs/testing.md.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CoverageBar } from "@/components/CoverageBar";
import { coverageAriaLabel, coverageSegments } from "@/lib/coverage";
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

describe("CoverageBar", () => {
  it("has an accessible name matching the computed distribution, delegated from lib/coverage", () => {
    const dist = coverage({ left: 3, center: 1, right: 4 });
    render(<CoverageBar coverage={dist} />);

    const bar = screen.getByRole("img");
    expect(bar).toHaveAccessibleName(coverageAriaLabel(dist));
  });

  it("renders segments in the fixed left-to-right lean order, not sorted by count", () => {
    // Distinct, non-monotonic counts, given out of lean order: if the DOM
    // order didn't actually follow LEANS order, this would produce a
    // different sequence than expected and the test would fail.
    const dist = coverage({ right: 7, left: 5, center: 3 });
    render(<CoverageBar coverage={dist} />);

    const bar = screen.getByRole("img");
    const segments = Array.from(bar.children) as HTMLElement[];
    const expectedOrder = coverageSegments(dist).map((segment) => String(segment.count));

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(expectedOrder);
  });

  it("total 0 renders no img role and an sr-only fallback instead", () => {
    render(<CoverageBar coverage={coverage({})} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("No source articles.")).toBeInTheDocument();
  });
});
