// The app's TWO named viewport seams, and the only `useMediaQuery` calls in it.
//
// They live here, named, rather than as `down("sm")` sprinkled through the
// pages, because the difference between the two is easy to get wrong and
// invisible when you do. Prefer an `sx` breakpoint object wherever the
// difference is purely visual — these are for when the DOM itself has to change,
// which is a much smaller set than it first looks.
//
// `noSsr` on both: this is a client-only SPA rendered with `createRoot`, so the
// query can be evaluated before first paint instead of assuming `false` and
// correcting in an effect. Without it a phone paints the desktop table for a
// frame and then throws it away.

import { useMediaQuery } from "@mui/material";
import type { Theme } from "@mui/material/styles";

/**
 * Below `sm` — a phone held upright, and the width at which the finds tables
 * stop being tables.
 *
 * Two things here cannot be expressed as styles, which is the whole reason this
 * is a hook and not a breakpoint object:
 * - The wide tables become **cards**: different markup, not restyled cells.
 *   `RoundTripTable` straddles cells with `rowSpan={2}`, and the usual CSS-only
 *   `display: block` responsive-table trick discards `rowSpan` outright — a
 *   trip's cabin, nights, seats and total would each print twice.
 * - `QuotaIndicator` is *unrendered* rather than hidden (see `Layout`), because
 *   a `display: none` element still measures, and something measures that one.
 */
export function useIsPhone(): boolean {
  return useMediaQuery((t: Theme) => t.breakpoints.down("sm"), { noSsr: true });
}

/**
 * Below `md` — too narrow to hold a pinned column beside the content it
 * navigates.
 */
export function useIsNarrow(): boolean {
  return useMediaQuery((t: Theme) => t.breakpoints.down("md"), { noSsr: true });
}
