import { Box } from "@mui/material";
import { Link } from "@tanstack/react-router";
import { STICKY_NAV_TOP } from "../lib/layout";

/**
 * One entry in a page's section nav. `key` is the URL segment as well as the
 * React key — the two are the same string on purpose, so a tab cannot be
 * renamed in the nav without its link moving with it.
 */
export interface SectionNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * A page's left-hand nav: one entry per section, each of them a real URL.
 *
 * **Links, not tabs.** This replaced a MUI `<Tabs orientation="vertical">`, and
 * the reason is not visual: once a section has its own route, the thing you
 * click is an anchor, and `role="tab"` would be a lie to a screen reader about
 * what pressing it does. TanStack sets `data-status="active"` on the anchor it
 * considers current, so the open entry is styled off that — the same mechanism
 * `NavLink` in `router.tsx` uses for the app bar's tabs.
 *
 * **The look is "the selected one lifts".** Idle entries are flat — no ground,
 * no border, muted ink — and the open one is a raised card with an accent
 * border. The nav it replaced drew a hairline down its whole edge with MUI's
 * 2px indicator riding on it, which spent a permanent rule to say a thing the
 * selection already says.
 *
 * **The children are the caller's plain `<Link>`s, and the styling reaches them
 * as descendants.** Both of the obvious alternatives destroy the type-checking
 * on the link: `styled(Link)` erases the router generics, so `params` widens to
 * `AnyRouter` and `{ tab }` stops being a known property; and a shared `to`
 * prop would have to be a union of every page's parent route, which TanStack
 * resolves to `never` params. A literal `to` at each call site is what keeps
 * `params={{ tab: t.key }}` checked against the real route tree — so the frame
 * and the look are shared here, and the links stay where they can be verified.
 *
 * Three details are load-bearing:
 * - **The border is always 1px, transparent when idle.** Growing one on
 *   selection would shift the label by a pixel every time you moved. It is the
 *   same problem `RouteNav`'s 3px `::before` solves by being a pseudo-element.
 * - **`secondary.main` for the accent, never `primary`.** `palette.primary` is
 *   the accent as a GROUND (dark enough to carry `onAccent`); as a border or a
 *   label it reads as washed out.
 * - **Every ground under text is a contrast-tested one.** `background.raised`
 *   and `action.hover` are both proven against `text.primary` for all
 *   twenty-one palettes (`theme/themes.contrast.test.ts`); `spec.accentMuted`
 *   and `spec.selectedIdle` are NOT, so the accent appears here only as ink and
 *   as a border, never as a ground with a label on it.
 */
export function SectionNav({
  label,
  children,
}: {
  /** Names the landmark, so a page with two navs (this and the app bar's) has
   *  two distinguishable ones. */
  label: string;
  /** `SectionNavLink`s. */
  children: React.ReactNode;
}) {
  return (
    // A column beside the content from `md` up, a scrolling strip above it below
    // that — a 190px rail on a 390px screen leaves about 150px for the pane it
    // is navigating. This is a plain `sx` breakpoint object and NOT `useIsNarrow`:
    // the DOM is identical at both widths now that the nav is flex rather than a
    // `Tabs` with an `orientation` prop, and the hooks are for when the DOM
    // itself has to change.
    //
    // `overflowX: auto` is safe here in a way it is not on the app bar's strip,
    // which cannot scroll because clipping at its padding box would eat the
    // `marginBottom: -1` joining the open tab to its page. Nothing here overlaps
    // its neighbour.
    <Box
      component="nav"
      aria-label={label}
      // Geometry is the only way to tell a strip from a column apart from the
      // outside, so `e2e/mobile.spec.ts` measures this box. It replaced an
      // assertion on MUI's `aria-orientation`, which went away with `Tabs`.
      data-testid="section-nav"
      sx={(theme) => ({
        display: "flex",
        flexDirection: { xs: "row", md: "column" },
        gap: 0.5,
        flexShrink: 0,
        minWidth: { md: 190 },
        maxWidth: "100%",
        overflowX: { xs: "auto", md: "visible" },
        pb: { xs: 0.5, md: 0 },
        // Pinned at its own resting position, the same as the Routes rail — the
        // content pane scrolls past a nav that never moves. `STICKY_NAV_TOP`
        // carries no `APP_BAR_HEIGHT` term; see its docblock.
        position: { md: "sticky" },
        top: { md: STICKY_NAV_TOP },
        "& a": {
          display: "flex",
          alignItems: "center",
          // Spacing units, not pixels — `sx` runs `gap` through the theme's
          // scale even inside a nested selector, so a bare `10` here is 80px.
          gap: 1.25,
          flexShrink: 0,
          padding: "8px 12px",
          minHeight: 40,
          borderRadius: `${theme.shape.borderRadius}px`,
          border: "1px solid transparent",
          whiteSpace: "nowrap",
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1.3,
          textDecoration: "none",
          color: theme.palette.text.secondary,
          transition: "background-color 120ms, border-color 120ms, color 120ms",
          "& .MuiSvgIcon-root": { fontSize: 18, color: theme.palette.text.disabled },
          "&:hover": {
            backgroundColor: theme.palette.action.hover,
            color: theme.palette.text.primary,
            "& .MuiSvgIcon-root": { color: theme.palette.text.secondary },
          },
        },
        '& a[data-status="active"]': {
          backgroundColor: theme.palette.background.raised,
          borderColor: theme.palette.secondary.main,
          color: theme.palette.text.primary,
          fontWeight: 600,
          "& .MuiSvgIcon-root": { color: theme.palette.secondary.main },
        },
      })}
    >
      {children}
    </Box>
  );
}

/**
 * The anchor a section nav entry is.
 *
 * A bare re-export of TanStack's `Link` — no wrapper, no `styled`, precisely so
 * `to` and `params` keep the router's own types (see `SectionNav`'s docblock).
 * It is re-exported under this name anyway so a call site reads as what it is
 * and so there is one obvious thing to put inside a `SectionNav`.
 */
export const SectionNavLink = Link;
