/**
 * Presentation metadata for the five-value `lean` enum.
 *
 * Colour accessibility notes — the spectrum is the one place in this UI where
 * colour carries meaning, so it is designed not to depend on colour alone:
 *
 *  - Hue runs blue -> neutral -> orange, not blue -> red. Blue/orange is the
 *    standard diverging pair that stays distinguishable under deuteranopia,
 *    protanopia and tritanopia; red/blue is not.
 *  - Lightness varies within each side (outer ends are darker than the inner
 *    ones), so adjacent segments are still separable in greyscale.
 *  - Position is fixed everywhere: left -> right, always in LEANS order.
 *  - Every bar is accompanied by text labels and counts, and carries a full
 *    aria-label describing the same distribution in words.
 *
 * The colours themselves live as CSS custom properties in globals.css so they
 * can be re-tuned for dark mode in one place.
 */

import type { Lean } from "./types";
import { LEANS } from "./types";

export interface LeanMeta {
  /** Full label, e.g. in a legend or a section heading. */
  label: string;
  /** Compact label for tight spaces. */
  shortLabel: string;
  /** Tailwind class painting the coverage bar segment. */
  barClass: string;
  /** Tailwind class for a small legend swatch. */
  swatchClass: string;
  /** Tailwind class for the accent rule beside a detail-view section. */
  railClass: string;
}

export const LEAN_META: Record<Lean, LeanMeta> = {
  left: {
    label: "Left",
    shortLabel: "L",
    barClass: "bg-spectrum-left",
    swatchClass: "bg-spectrum-left",
    railClass: "bg-spectrum-left",
  },
  lean_left: {
    label: "Lean left",
    shortLabel: "LL",
    barClass: "bg-spectrum-lean-left",
    swatchClass: "bg-spectrum-lean-left",
    railClass: "bg-spectrum-lean-left",
  },
  center: {
    label: "Center",
    shortLabel: "C",
    barClass: "bg-spectrum-center",
    swatchClass: "bg-spectrum-center",
    railClass: "bg-spectrum-center",
  },
  lean_right: {
    label: "Lean right",
    shortLabel: "LR",
    barClass: "bg-spectrum-lean-right",
    swatchClass: "bg-spectrum-lean-right",
    railClass: "bg-spectrum-lean-right",
  },
  right: {
    label: "Right",
    shortLabel: "R",
    barClass: "bg-spectrum-right",
    swatchClass: "bg-spectrum-right",
    railClass: "bg-spectrum-right",
  },
};

/** Re-exported so components import order and labels from one place. */
export const LEAN_ORDER: readonly Lean[] = LEANS;

export function leanLabel(lean: Lean): string {
  return LEAN_META[lean].label;
}
