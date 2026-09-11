/**
 * The coverage spread bar — the product's core idea made visible.
 *
 * Five proportional segments in fixed left -> right order. Colour is the fast
 * signal; the fixed order, the text legend and the aria-label are the ones that
 * still work without it.
 */

import {
  coverageAriaLabel,
  coverageSegments,
  coverageTotal,
} from "@/lib/coverage";
import { LEAN_META, LEAN_ORDER } from "@/lib/lean";
import type { Coverage } from "@/lib/types";

type BarSize = "sm" | "lg";
type LegendMode = "none" | "compact" | "full";

const BAR_HEIGHT: Record<BarSize, string> = {
  sm: "h-2",
  lg: "h-4",
};

export function CoverageBar({
  coverage,
  size = "sm",
  legend = "compact",
}: {
  coverage: Coverage;
  size?: BarSize;
  legend?: LegendMode;
}) {
  const total = coverageTotal(coverage);
  const segments = coverageSegments(coverage);

  if (total === 0) {
    return (
      <div className={`${BAR_HEIGHT[size]} w-full rounded-full bg-surface-muted`}>
        <span className="sr-only">No source articles.</span>
      </div>
    );
  }

  return (
    <div>
      {/* gap-px over a border-coloured track draws hairlines between segments,
          so the bands stay distinguishable even if two colours read alike. */}
      <div
        role="img"
        aria-label={coverageAriaLabel(coverage)}
        className={`flex ${BAR_HEIGHT[size]} w-full gap-px overflow-hidden rounded-full bg-border`}
      >
        {segments.map((segment) => (
          <div
            key={segment.lean}
            aria-hidden="true"
            title={`${LEAN_META[segment.lean].label}: ${segment.count} of ${total}`}
            className={`${LEAN_META[segment.lean].barClass} min-w-[3px]`}
            style={{ flexGrow: segment.count, flexBasis: 0 }}
          />
        ))}
      </div>

      {legend === "compact" ? (
        <CompactLegend coverage={coverage} />
      ) : legend === "full" ? (
        <FullLegend coverage={coverage} total={total} />
      ) : null}
    </div>
  );
}

/** Non-zero buckets only, as text. Used on story cards. */
function CompactLegend({ coverage }: { coverage: Coverage }) {
  const present = LEAN_ORDER.filter((lean) => coverage[lean] > 0);

  return (
    <ul
      aria-hidden="true"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] leading-4 text-subtle"
    >
      {present.map((lean) => (
        <li key={lean} className="flex items-center gap-1.5">
          <span
            className={`${LEAN_META[lean].swatchClass} inline-block size-2 shrink-0 rounded-full`}
          />
          <span>
            {LEAN_META[lean].label}
            <span className="ml-1 tabular-nums text-muted">{coverage[lean]}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** All five buckets including zeros — a missing side is the interesting part. */
function FullLegend({ coverage, total }: { coverage: Coverage; total: number }) {
  return (
    <ul
      aria-hidden="true"
      className="mt-3 grid grid-cols-5 gap-2 text-[0.6875rem] leading-4"
    >
      {LEAN_ORDER.map((lean) => {
        const count = coverage[lean];
        const percent = Math.round((count / total) * 100);
        return (
          <li key={lean} className="min-w-0">
            <span
              className={`${LEAN_META[lean].swatchClass} mb-1.5 block h-1 w-full rounded-full ${
                count === 0 ? "opacity-25" : ""
              }`}
            />
            <span
              className={`block truncate ${count === 0 ? "text-subtle" : "text-muted"}`}
            >
              {LEAN_META[lean].label}
            </span>
            <span
              className={`block tabular-nums ${
                count === 0 ? "text-subtle" : "font-medium text-foreground"
              }`}
            >
              {count === 0 ? "none" : `${count} · ${percent}%`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
