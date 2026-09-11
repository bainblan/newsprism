/**
 * Derived read-outs of a story's coverage distribution.
 *
 * Everything here is arithmetic on the `coverage` object the backend already
 * sends — nothing is invented and nothing is fetched. The thresholds are UI
 * copy decisions, deliberately kept in one file so they can be argued about in
 * one place rather than scattered through components.
 */

import type { Coverage, Lean } from "./types";
import { LEANS } from "./types";
import { LEAN_META } from "./lean";

/**
 * Sum of all five buckets. The contract guarantees this equals `article_count`,
 * but the bar divides by it, so it is computed rather than trusted — a mismatch
 * should render slightly wrong, not crash or produce Infinity.
 */
export function coverageTotal(coverage: Coverage): number {
  return LEANS.reduce((sum, lean) => sum + (coverage[lean] || 0), 0);
}

export type SkewTone = "one-sided" | "leaning" | "centered" | "balanced" | "none";

export interface CoverageSkew {
  tone: SkewTone;
  /** Short sentence for display, e.g. "Mostly right-of-center coverage". */
  label: string;
  /** Sides with literally zero articles, when the story is big enough to matter. */
  blindspots: Array<"left" | "right" | "center">;
}

const ONE_SIDED_THRESHOLD = 0.8;
const LEANING_THRESHOLD = 0.6;
/** Below this many articles, a missing side is not yet a meaningful blind spot. */
const BLINDSPOT_MIN_ARTICLES = 3;

export function describeSkew(coverage: Coverage): CoverageSkew {
  const total = coverageTotal(coverage);
  if (total === 0) {
    return { tone: "none", label: "No coverage", blindspots: [] };
  }

  const leftCount = coverage.left + coverage.lean_left;
  const rightCount = coverage.right + coverage.lean_right;
  const centerCount = coverage.center;

  const leftShare = leftCount / total;
  const rightShare = rightCount / total;
  const centerShare = centerCount / total;

  const blindspots: CoverageSkew["blindspots"] = [];
  if (total >= BLINDSPOT_MIN_ARTICLES) {
    if (leftCount === 0) blindspots.push("left");
    if (centerCount === 0) blindspots.push("center");
    if (rightCount === 0) blindspots.push("right");
  }

  let tone: SkewTone = "balanced";
  let label = "Broadly balanced coverage";

  if (leftShare >= ONE_SIDED_THRESHOLD) {
    tone = "one-sided";
    label = "Almost entirely left-of-center coverage";
  } else if (rightShare >= ONE_SIDED_THRESHOLD) {
    tone = "one-sided";
    label = "Almost entirely right-of-center coverage";
  } else if (leftShare >= LEANING_THRESHOLD) {
    tone = "leaning";
    label = "Mostly left-of-center coverage";
  } else if (rightShare >= LEANING_THRESHOLD) {
    tone = "leaning";
    label = "Mostly right-of-center coverage";
  } else if (centerShare >= LEANING_THRESHOLD) {
    tone = "centered";
    label = "Mostly center coverage";
  }

  return { tone, label, blindspots };
}

export function blindspotLabel(side: "left" | "right" | "center"): string {
  switch (side) {
    case "left":
      return "No left-of-center coverage";
    case "right":
      return "No right-of-center coverage";
    case "center":
      return "No center coverage";
  }
}

/**
 * A full spoken description of the distribution, for the bar's aria-label.
 * Screen reader users get the same information sighted users get from colour.
 */
export function coverageAriaLabel(coverage: Coverage): string {
  const total = coverageTotal(coverage);
  if (total === 0) return "No source articles.";

  const parts = LEANS.filter((lean) => coverage[lean] > 0).map((lean) => {
    const count = coverage[lean];
    const percent = Math.round((count / total) * 100);
    return `${LEAN_META[lean].label} ${count} (${percent}%)`;
  });

  const missing = LEANS.filter((lean) => coverage[lean] === 0).map(
    (lean) => LEAN_META[lean].label,
  );

  const missingClause =
    missing.length > 0 ? ` No coverage from: ${missing.join(", ")}.` : "";

  return `Coverage spread across ${total} source article${
    total === 1 ? "" : "s"
  }: ${parts.join(", ")}.${missingClause}`;
}

export interface CoverageSegment {
  lean: Lean;
  count: number;
  percent: number;
}

/** Non-empty buckets only, in fixed left-to-right order, with percentages. */
export function coverageSegments(coverage: Coverage): CoverageSegment[] {
  const total = coverageTotal(coverage);
  if (total === 0) return [];
  return LEANS.filter((lean) => coverage[lean] > 0).map((lean) => ({
    lean,
    count: coverage[lean],
    percent: (coverage[lean] / total) * 100,
  }));
}
