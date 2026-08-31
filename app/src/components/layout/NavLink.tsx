import { styled } from "@mui/material";
import { Link } from "@tanstack/react-router";

/**
 * A page, drawn as an editor tab.
 *
 * TanStack `<Link>` sets `data-status="active"` on the anchor; styling off that
 * keeps the type-safe router props (`to`, `activeOptions`) without MUI Button
 * casts — which is why this is a `styled` anchor and not a `<Tabs>`.
 *
 * The tab-ness is three details, and all three are load-bearing:
 * - **Full height, square, separated by a rule.** Pills float on a bar; tabs
 *   *are* the bar. `alignItems: stretch` on the toolbar is what lets them fill
 *   it, so don't set a height here.
 * - **The active tab is painted the PAGE's colour**, not an accent tint, so it
 *   reads as the open document rather than as a selected button.
 * - **It joins the page.** The 2px accent sits on top (VS Code's default
 *   position), and the -1px bottom margin lets the tab paint over the app bar's
 *   bottom rule so there is no line between the open tab and its page.
 */
export const NavLink = styled(Link)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  // Tighter on a phone. The tabs at desktop padding plus the right-hand
  // controls overrun a narrow bar, and the toolbar is deliberately `overflow:
  // visible` (see `Layout`), so they OVERLAP rather than clip.
  //
  // This padding is only half the fix and cannot be the whole of it: the tabs
  // are what they are, so the bar is balanced by DROPPING the quota chip below
  // `sm` (see `Layout`) rather than by squeezing the labels further. Scrolling
  // the strip is not available — an `overflow-x: auto` nav clips at its padding
  // box, which would eat the `marginBottom: -1` that joins the active tab to its
  // page.
  padding: "0 8px",
  [theme.breakpoints.up("sm")]: { padding: "0 16px" },
  whiteSpace: "nowrap",
  fontSize: 13,
  fontWeight: 500,
  textDecoration: "none",
  // The palette's own tab colours, not a wash of the bar: an idle tab is
  // `tabIdleText` on the chrome ground, a hovered one is `tabHover`, and the
  // open one is the PAGE's colour with the palette's bright `indicator` on top.
  color: theme.spec.tabIdleText,
  borderRight: `1px solid ${theme.palette.divider}`,
  borderTop: "2px solid transparent",
  marginBottom: -1,
  borderBottom: "1px solid transparent",
  "&:hover": {
    color: theme.palette.text.primary,
    backgroundColor: theme.spec.tabHover,
  },
  '&[data-status="active"]': {
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.background.default,
    borderTopColor: theme.spec.indicator,
    borderBottomColor: theme.palette.background.default,
  },
}));