// The app's shared layout numbers. No JSX and no components — these are tuned
// constants that several surfaces have to agree on, and a second copy of any of
// them is how two panes end up a few pixels apart.

/** The page container's vertical padding, in theme spacing units (→ 20px).
 *  Exported because `STICKY_NAV_TOP` is derived from it — see below. */
export const PAGE_PY = 2.5;

/** The page container's horizontal padding, per breakpoint.
 *
 *  Lives here rather than in `router.tsx` because padding is a PAGE's
 *  decision — the shell doesn't apply it — and `PagePad` is the one place the
 *  pages that want it get it. */
export const GUTTERS = { xs: 1.5, sm: 2, lg: 3 };

/** The app bar's height: a 40px title-bar/tab strip plus the rule under it.
 *
 *  Fixed at every breakpoint, unlike MUI's Toolbar — `Layout` pins the
 *  `minHeight` rather than letting it shrink on a landscape phone, precisely so
 *  `STICKY_NAV_TOP` below is a true number on every screen instead of only from
 *  `md` up. */
export const APP_BAR_HEIGHT = 41;

/** Where the Library's tab column pins.
 *
 *  It is *exactly where that nav already sits* unscrolled: past its scroller's
 *  top padding. Pinning any higher means the nav jumps up by the difference the
 *  moment the page moves, which reads as a nav that doesn't hold its place
 *  rather than as a page sliding underneath one that does.
 *
 *  **There is no `APP_BAR_HEIGHT` term here, and that is the point.** The
 *  document itself does not scroll — `Layout` is a fixed-height column and
 *  each page owns a scroll container inside it (`PagePad` here) — so a sticky
 *  child is offset from ITS SCROLLER's top edge, which already starts below
 *  the tab strip. Adding the bar's height back would push the column down by
 *  41px the instant anything scrolled.
 *
 *  A nav is only pinned from `md` up — a pinned column is worth little on a
 *  screen narrower than that. The Routes rail does not use this at all: it is
 *  a full-height pane with its own scrollbar, which is what a sidebar is. */
export const STICKY_NAV_TOP = 8 * PAGE_PY;

/**
 * The left margin a small `Switch` in a `FormControlLabel` needs to line its
 * track up with the fields or text beside it.
 *
 * `FormControlLabel` hangs its control by a flat -11px, which is tuned for a
 * DEFAULT-size Switch: that one carries 12px of padding around its 34px track,
 * so -11 lands the visible track a pixel inside the content edge. A small Switch
 * pads by 7, so the same -11 overhangs to the left of every field in the form —
 * which is what it looked like. Matching the padding puts the track exactly on
 * the edge.
 *
 * Shared rather than redefined: it is a tuned number about MUI's internals, and
 * a second copy is how the route form and the preferences dialog would end up
 * a few pixels apart.
 */
export const SWITCH_ROW_ML = "-7px";

/**
 * What the Date column reserves, in both tables.
 *
 * A constant rather than the column's natural width, because `dayLabel`'s output
 * is not a fixed length — "Fri, Oct 9" against "Sat, Jan 3, 2027" — so a
 * content-sized column is as wide as whichever dates a given route happens to
 * hold, and every column to its right jumps sideways when you select a different
 * route. Wide enough for the longest form the label can produce, at this app's
 * 13px density and a cell's 16px of padding either side.
 *
 * Shared so the one-way and round-trip tables can't disagree: they run the same
 * columns in the same order precisely so they read alike.
 */
export const DATE_CELL_WIDTH = 148;
