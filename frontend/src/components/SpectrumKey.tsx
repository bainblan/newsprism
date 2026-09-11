/**
 * The legend for the coverage bars, shown once at the top of the list. Without
 * it the bars are just coloured stripes; with it the whole page is readable.
 */

import { LEAN_META, LEAN_ORDER } from "@/lib/lean";

export function SpectrumKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-xs text-subtle">Coverage spread</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {LEAN_ORDER.map((lean) => (
          <li key={lean} className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={`${LEAN_META[lean].swatchClass} inline-block h-2 w-4 rounded-sm`}
            />
            {LEAN_META[lean].label}
          </li>
        ))}
      </ul>
    </div>
  );
}
