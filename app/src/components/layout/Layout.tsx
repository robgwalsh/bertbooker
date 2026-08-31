import { Box, AppBar, Toolbar, Stack } from "@mui/material";
import { Outlet } from "@tanstack/react-router";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { APP_BAR_HEIGHT } from "../../lib/layout";
import { QuotaIndicator } from "../QuotaIndicator";
import { SettingsButton } from "../settings/SettingsDialog";
import { NavLink } from "./NavLink";
import { AlertsHealthDot } from "./AlertsHealthDot";
import { SignOut } from "./SignOut";

/**
 * The app shell: a title bar with a tab strip in it, and the page under that.
 *
 * One row rather than VS Code's two (title bar, then tabs) because there are
 * four pages and a handful of controls — a dedicated 35px strip for four tabs
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
export function Layout() {
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
            {/* `includeSearch: false`: the Routes page keeps its selected route
                and nights range in `?route=`/`?minNights=`/`?maxNights=`
                (searchParams.ts), so the URL at "/" is almost never bare. The
                default active-match is search-inclusive, so without this the
                tab reads as closed the moment anything is selected — which is
                the normal state, not an edge case. */}
            <NavLink to="/" activeOptions={{ exact: true, includeSearch: false }}>
              Routes
            </NavLink>
            {/* The one tab that reports on work nobody triggered. It carries a
                dot when a sweep is failing, because no email is ever sent about
                that — this strip is where you would first notice. */}
            <NavLink to="/alerts">
              Alerts
              <AlertsHealthDot />
            </NavLink>
            <NavLink to="/library">Library</NavLink>
            {/* No `activeOptions`: the default match is a PREFIX match, which
                is what keeps this tab lit while `/tools/coverage` is open. The
                same is true of Library and Alerts; only `/` needs `exact`,
                because the index path would otherwise prefix-match everything.

                Fourth, and the bar is now measured rather than assumed —
                `e2e/mobile.spec.ts` checks this strip against the controls at
                390px. "Tools" is the shortest label on it, which is not an
                accident. */}
            <NavLink to="/tools">Tools</NavLink>
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
            // the next tab added fails a test instead of quietly landing the
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
            <SettingsButton />
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
