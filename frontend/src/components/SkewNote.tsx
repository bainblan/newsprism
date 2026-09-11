/**
 * The one-line verdict that goes with a coverage bar: which way the coverage
 * leans, and which side is missing entirely. Both are computed from `coverage`
 * in src/lib/coverage.ts — nothing here comes off the wire.
 */

import { blindspotLabel, describeSkew } from "@/lib/coverage";
import type { Coverage } from "@/lib/types";

export function SkewNote({
  coverage,
  size = "sm",
}: {
  coverage: Coverage;
  size?: "sm" | "md";
}) {
  const skew = describeSkew(coverage);
  if (skew.tone === "none") return null;

  const emphatic = skew.tone === "one-sided" || skew.tone === "leaning";

  return (
    <p
      className={`${size === "md" ? "text-sm" : "text-xs"} leading-5 ${
        emphatic ? "font-medium text-foreground" : "text-muted"
      }`}
    >
      {skew.label}
      {skew.blindspots.length > 0 ? (
        <>
          {" · "}
          <span className="text-muted">
            {skew.blindspots.map(blindspotLabel).join(" · ")}
          </span>
        </>
      ) : null}
    </p>
  );
}
