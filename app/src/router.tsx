import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppBar, Box, IconButton, Stack, Toolbar, Tooltip } from "@mui/material";
import { styled } from "@mui/material/styles";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import { Routes } from "./pages/Routes";
import { Library } from "./pages/Library";
import { Alerts } from "./pages/Alerts";
import { QuotaIndicator } from "./QuotaIndicator";
// `PreferencesButton.tsx`, not `Preferences.tsx`: the store beside it is
// `preferences.ts`, and two files differing only in case are ONE file to
// TypeScript on a case-insensitive filesystem. Named for its export, as
// `QuotaIndicator.tsx` is.
import { PreferencesButton } from "./PreferencesButton";
import { api } from "./api";
import { notifyLocked } from "./auth";
import { MAX_NIGHTS, MAX_NIGHTS_SPAN } from "./roundtrip";
import { APP_BAR_HEIGHT, useIsPhone } from "./ui";

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
const NavLink = styled(Link)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  // Tighter on a phone. The tabs at desktop padding plus the right-hand
  // controls overrun a narrow bar, and the toolbar is deliberately `overflow:
  // visible` (see `Layout`), so they OVERLAP rather than clip — the quota chip
  // used to land on top of the last tab.
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

/**
 * The app shell: a title bar with a tab strip in it, and the page under that.
 *
 * One row rather than VS Code's two (title bar, then tabs) because there are
 * three pages and a handful of controls — a dedicated 35px strip for three tabs
 * would spend a row of screen to look more like an editor and be less of one.
 * The tabs own the left edge outright and the app-level controls take the right;
 * there is no brand block, because an editor's tab strip starts at the edge.
 *
 * `alignItems: "stretch"` is what makes the tabs full-height, and `overflow:
 * visible` is what lets the active one paint over the bar's bottom rule — see
 * `NavLink`. The toolbar is deliberately un-guttered: tabs that stopped short of
 * the edge would float, and a tab strip runs edge to edge.
 *
 * **The shell is a fixed-height column and it does not scroll.** That is the
 * workbench model, and it is what the Routes page needed: a sidebar is only a
 * sidebar if it runs the full height with its own scrollbar, which cannot happen
 * while the document is the thing that scrolls and the rail is a card floating
 * in it. So the shell pads nothing and scrolls nothing, and each page owns both
 * — `PagePad` for the pages that are documents, panes with their own `overflow`
 * for the one that is a workbench.
 *
 * `position="static"` on the AppBar rather than `sticky`: with no document
 * scroll there is nothing to stick to, and static keeps it a normal flex child
 * so `flex: 1` below measures the space that is actually left.
 */
/**
 * A dot on the Alerts tab when the scheduler is in trouble.
 *
 * This is small and it is load-bearing. A failed sweep sends NO email — only
 * finds do — so a scheduler that has been blocked all week produces exactly the
 * same silence as one that ran and found nothing. Without a signal in the shell
 * you would only discover it by opening a tab you have no reason to open.
 *
 * Renders nothing when there is nothing wrong, and never blocks the bar: a
 * failed query is not itself an alarm.
 */
function AlertsHealthDot() {
  const { data } = useQuery({
    queryKey: ["alert-schedule"],
    queryFn: api.alertSchedule,
    // The cron wakes every 15 minutes; polling faster than that learns nothing.
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  if (!data) return null;
  const unhealthy =
    data.routes.some((r) => r.consecutiveFailures > 0 || r.windowExpired) ||
    (data.routes.length > 0 && !data.pacing.affordable) ||
    (data.routes.length > 0 && !data.email.configured) ||
    Boolean(data.budget.blockedReason);
  if (!unhealthy) return null;
  return (
    <Box
      component="span"
      aria-label="Alerts need attention"
      sx={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        ml: 0.75,
        verticalAlign: "middle",
        bgcolor: "warning.main",
      }}
    />
  );
}

function Layout() {
  const narrow = useIsPhone();
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" elevation={0} sx={{ flexShrink: 0 }}>
        <Toolbar
          disableGutters
          sx={{
            minHeight: `${APP_BAR_HEIGHT - 1}px !important`,
            alignItems: "stretch",
            overflow: "visible",
          }}
        >
          {/* No brand block. There was a plane mark and a "BertBooker" wordmark
              here; an editor's tab strip starts at the left edge, and the app
              already says what it is in the browser tab. The tabs are the whole
              left side now, and `/` renders Routes, so Routes is the open one on
              arrival. */}
          <Box component="nav" sx={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
            <NavLink to="/" activeOptions={{ exact: true }}>
              Routes
            </NavLink>
            <NavLink to="/library">Library</NavLink>
            {/* The one tab that reports on work nobody triggered. It carries a
                dot when a sweep is failing, because no email is ever sent about
                that — this strip is where you would first notice. */}
            <NavLink to="/alerts">
              Alerts
              <AlertsHealthDot />
            </NavLink>
          </Box>
          {/* The metered allowance belongs to the app, not to a page: Search
              spends it from Routes and every enrich control in the finds table
              spends it too. Renders nothing until a metered source has actually
              reported a number. */}
          <Stack
            direction="row"
            spacing={{ xs: 0.5, sm: 1 }}
            // The one test hook in the app, and it earns its place: the bar
            // overlapping itself is a real bug that shipped once already, and it
            // is a GEOMETRY bug — the only way to catch it is to measure this box
            // against the tab strip's. `e2e/mobile.spec.ts` does exactly that, so
            // adding a fifth tab fails a test instead of quietly landing the
            // controls on top of it.
            data-testid="app-bar-controls"
            sx={{
              ml: "auto",
              alignItems: "center",
              // Tighter than the page gutter on a phone: this cluster is
              // competing with the tabs for one 390px bar, and the gap between
              // the last tab and the gear is the cheapest pixel on it.
              px: { xs: 0.5, sm: 2, lg: 3 },
              flexShrink: 0,
            }}
          >
            {/* NOT rendered on a phone, and unrendered rather than hidden.
                `QuotaSplash` finds this by id to animate into it and ALREADY
                handles the element being absent — it skips the flight and just
                fades (see its `close`). A `display: none` chip would still
                resolve by id and hand back an all-zero rect, so the splash would
                fly to the top-left corner and scale to nothing. There is no
                third option here: hiding it is the broken one.

                Nothing is lost. The chip is a passive readout, and the spending
                it reports is started from the Routes page, which is wide enough
                to show it the moment the screen is. */}
            {!narrow && <QuotaIndicator />}
            {/* A SIBLING of the quota chip, never a wrapper around it:
                `QuotaSplash` measures that element by id to animate into it,
                so anything that changes its box breaks the splash. Note it
                renders nothing until a metered source has reported, which is
                why the gear has to look right sitting straight beside Sign
                out too. */}
            <PreferencesButton />
            <SignOut />
          </Stack>
        </Toolbar>
      </AppBar>
      {/* All the room that is left, and nothing else: no padding, no scrollbar,
          no max width. `minHeight: 0` is what lets a child actually shrink to
          this box and scroll inside it — without it a flex item floors at its
          content height and the overflow escapes the viewport instead.
          `minWidth: 0` is the same rule on the other axis, and it is what keeps
          a page that is momentarily too wide from widening the SHELL: a flex
          item's min-width is `auto`, so without it an over-wide table drags the
          app bar sideways with it and the whole document scrolls horizontally. */}
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Box>
  );
}

/**
 * Sign out.
 *
 * The session is an HttpOnly cookie, so only the Worker can actually clear it —
 * hence the round trip. `notifyLocked` is then the same hand-off a 401 uses
 * (`web/src/auth.ts`), so signing out and being timed out land on exactly one
 * code path.
 *
 * It runs BEFORE `queryClient.clear()`, and the order is not cosmetic: locking
 * first unmounts the app, so clearing the cache can't set every still-mounted
 * panel refetching against a session that no longer exists. The clear itself is
 * required — leaving it out would render a signed-out app full of the previous
 * session's data the moment anyone signed back in.
 */
function SignOut() {
  const queryClient = useQueryClient();
  return (
    <Tooltip title="Sign out">
      <IconButton
        size="small"
        aria-label="Sign out"
        onClick={async () => {
          await api.logout();
          notifyLocked();
          queryClient.clear();
        }}
      >
        <LogoutRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

const rootRoute = createRootRoute({ component: Layout });

/** Which tracked route the Routes page has open, and how it is reading it. All
 *  four live in the URL rather than in component state so a reload, a bookmark
 *  and the back button all land on the view you were reading. Search params are
 *  untrusted input: anything that isn't valid becomes `undefined`, and the page
 *  falls back to a default rather than rendering an empty pane. */
export interface RoutesSearchParams {
  route?: number;
  /**
   * Trip length for a round-trip route's pairing. A reading preference, not a
   * route setting — whether the route pairs at all is `round_trip` on the row
   * itself, edited like every other property.
   *
   * ABSENT IS THE DEFAULT AND MEANS "the whole-window trip": out on the route's
   * `date_start`, back on its `date_end`, and no other pair of dates. That is a
   * different question from any nights range rather than the widest one, which is
   * why absence still spells it — there is deliberately no third param naming the
   * mode, since "no range chosen" and "the whole-window trip" are one state and
   * two ways to spell it would eventually disagree. Present only when somebody
   * picked a range, and only ever as a pair.
   */
  minNights?: number;
  maxNights?: number;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Routes,
  validateSearch: (search: Record<string, unknown>): RoutesSearchParams => {
    const n = Number(search.route);
    const nights = (v: unknown): number | undefined => {
      const x = Number(v);
      return Number.isInteger(x) && x >= 0 && x <= MAX_NIGHTS ? x : undefined;
    };
    let minNights = nights(search.minNights);
    let maxNights = nights(search.maxNights);
    // An inverted or absurdly wide pair is not an error to render, it is a pair
    // to drop: the page falls back to the whole window, exactly the way an
    // unknown `route` falls back to the first one. Dropped together, since half
    // a range is not a range — and a lone `minNights` would otherwise read as a
    // chosen range with a made-up other end.
    if (
      minNights != null &&
      maxNights != null &&
      (minNights > maxNights || maxNights - minNights > MAX_NIGHTS_SPAN)
    ) {
      minNights = undefined;
      maxNights = undefined;
    }
    return {
      route: Number.isInteger(n) && n > 0 ? n : undefined,
      minNights,
      maxNights,
    };
  },
});
const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/library", component: Library });

// The scheduled sweep — the one page about work nobody triggered.
const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts",
  component: Alerts,
});

// Three routes. There were two others: /calendar, a month grid for one route,
// and /harvest, the console for the local scrapers. Both were removed because
// nothing used them — the scrapers themselves are gone (docs/HARVEST-POSTMORTEM.md),
// and the Harvest tab's Database pane went the same way as /calendar. That
// leaves the Routes page as the single place stored finds are read: one surface
// over `findsCte`, rather than a dashboard and a browser drifting apart about
// what a current find is.
const routeTree = rootRoute.addChildren([indexRoute, libraryRoute, alertsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
