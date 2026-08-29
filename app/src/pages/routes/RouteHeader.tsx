import { Box, Chip, IconButton, LinearProgress, Stack, Typography } from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import NotificationsNoneRoundedIcon from "@mui/icons-material/NotificationsNoneRounded";
import { ALERT_HEALTH, alertHealth } from "../../lib/alerts";
import { RouteDiagram } from "./RouteDiagram";
import { RouteFilterChips } from "./RouteFilterChips";
import { MUTED_CHIP_SX, SpecValue } from "./SpecValue";
import { ALERTS_OFF_HELP, alertHelp, alertOnLabel } from "./alertCopy";
import { searchedHelp, searchedLabel } from "./labels";
import { usDate } from "./dates";
import type { RouteField } from "./form";
import type { AirportName, AlertScheduleRoute, TrackedRoute } from "../../api";

/**
 * The selected route's header: what this route is, and the controls that act
 * on it, on one line.
 *
 * ONE ROW where it fits, and it stays put. It was two tiers — identity above, a
 * labelled six-cell spec grid below — which cost about 120px of the pane before
 * a single find, and scrolled away the moment you read past the first page of
 * results. A sticky band only earns its height once, so it has to be short: the
 * spec is bare values with their labels moved into tooltips. The find count is
 * gone — the rail already counts every route, including this one.
 *
 * The read filters are the one thing here that can wrap to a second chip line on
 * a middling pane width, and they earn it: they are CONTROLS, not statements,
 * and every one of them is rendered whether it constrains or not so that an
 * unset filter is still one click from being set. `RouteFilterChips` owns that
 * argument. Below `sm` they collapse into a single chip of their own, which is
 * what keeps a phone's band to one line.
 *
 * The one status it keeps is FRESHNESS, and it sits with the actions rather
 * than in the spec: everything in that strip is a setting you can change, while
 * "Searched 2h ago" is a fact about what has already happened to this route —
 * and the button that changes it is the next thing to its right.
 *
 * `position: sticky` resolves against the editor pane's own scroller from `md`
 * up and against the stacked page below it, so the same `top: 0` is right on
 * both.
 */
export function RouteHeader({
  route,
  names,
  alert,
  intervalMinutes,
  onEdit,
  onBack,
  refreshing,
  actions,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** This route's row from `GET /api/alerts/schedule`, when it has one and the
   *  query has landed. Only HEALTH and CADENCE come from here; the settings
   *  themselves are on `route`. Absent for a route with alerts off, and absent
   *  for every route until the shell's poll resolves — so nothing may depend on
   *  it being there. */
  alert?: AlertScheduleRoute;
  /** The pacing interval the scheduler is actually keeping, as the server
   *  computed it. Never re-derived here — see docs/ALERTS.md §4. */
  intervalMinutes?: number | null;
  /** Open the edit dialog, optionally landing on one field. */
  onEdit: (focus?: RouteField) => void;
  /** Back to the route list. Only reachable below `md`, where the rail and this
   *  pane are two screens rather than two panes — see the workbench grid. */
  onBack: () => void;
  /** The page's own query is re-reading. Drawn as a bar ON the header's bottom
   *  rule, because the pane below can be a full screen of finds that are about
   *  to change and a filter chip is small enough to click and not notice. */
  refreshing?: boolean;
  actions: React.ReactNode;
}) {
  const alertsOn = route.alerts_enabled === 1;

  return (
    // Full-bleed, with one rule under it and nothing else: this is the top of
    // the editor pane, not a card floating in a page. Opaque `background.default`
    // is load-bearing now that it is sticky — the table scrolls underneath it.
    <Box
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 3,
        bgcolor: "background.default",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      {/* Absolutely positioned over the bottom rule, so a refresh never moves
          the band it sits on — the one thing a sticky header must not do. */}
      {refreshing && (
        <LinearProgress
          sx={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, zIndex: 1 }}
        />
      )}
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ px: { xs: 1.5, sm: 2.5 }, py: 1, alignItems: "center", flexWrap: "wrap" }}
      >
        {/* WHICH FLIGHTS THIS ROUTE IS: the airports say where, the window says
            when, and the two are one statement, so they sit together as one item
            that wraps as one. The back arrow is INSIDE that item rather than
            beside it — as its own flex child it was the one thing narrow enough
            to fit when the route beside it wasn't, so a phone spent a whole row
            on a 34px arrow.

            NOTHING here is width-reserved. Aligning the filter strip to a fixed
            column across routes cost more horizontal room than the alignment was
            worth — at 1268px the strip ran out of row and wrapped, which is a
            worse jump than the one the reservation was avoiding. */}
        <Stack
          direction="row"
          spacing={1.25}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
        >
          {/* Only below `md` — above it the list is already on screen to the
              left, so this would be a button that undoes nothing. Hidden with
              `sx` rather than a second `useIsNarrow`: it is genuinely just
              visibility. */}
          <IconButton
            size="small"
            aria-label="All routes"
            onClick={onBack}
            sx={{ display: { xs: "inline-flex", md: "none" }, flexShrink: 0, ml: -0.5 }}
          >
            <ArrowBackRoundedIcon fontSize="small" />
          </IconButton>

          <RouteDiagram route={route} names={names} onEditSide={onEdit} />
          <SpecValue
            help="The departure dates this route watches."
            onClick={() => onEdit("dateStart")}
          >
            {/* A step down on a phone, and only there: at the body size the
                window is the last thing on the row and the first to be pushed
                off it, which costs a whole line for two dates that read fine a
                point smaller. The `sm` value is read off the variant rather than
                restated, so the two cannot drift apart. */}
            <Typography
              variant="body2"
              sx={(t) => ({
                fontWeight: 600,
                whiteSpace: "nowrap",
                fontSize: { xs: 11.5, sm: t.typography.body2.fontSize },
              })}
            >
              {usDate(route.date_start)} – {usDate(route.date_end)}
            </Typography>
          </SpecValue>
        </Stack>

        {/* The spec, unlabelled. Every value keeps its help text as a tooltip,
            so nothing about the route goes unexplained — only unlabelled,
            which is what buys the row back. */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
        >
          {/* The one value here describing what the route GATHERS rather than
              what it shows — every other setting can be changed and seen
              instantly, this one needs a search behind it. The diagram draws it
              too (two planes), so it is a chip only when it is on. */}
          {route.round_trip === 1 && (
            <SpecValue
              help="Round trip searches the reverse pair in the same call, for no extra seats.aero calls. It changes what is gathered, so it needs a search."
              onClick={() => onEdit("roundTrip")}
            >
              <Chip size="small" color="primary" variant="outlined" label="Round trip" />
            </SpecValue>
          )}

          {/* Alerts leads the chips. It is the one here that is not a filter —
              it changes what is GATHERED and is the only setting on this row that
              spends metered calls with nobody watching — so it takes the position
              you read first rather than the one you reach last. Stated even when
              OFF, because a route that isn't enrolled looks exactly like an app
              that doesn't have alerts. */}
          <SpecValue
            help={alertsOn ? alertHelp(route, alert, intervalMinutes) : ALERTS_OFF_HELP}
            onClick={() => onEdit(alertsOn ? "alertOn" : "alertsEnabled")}
          >
            {alertsOn ? (
              <Chip
                size="small"
                variant="outlined"
                color={alert ? ALERT_HEALTH[alertHealth(alert)].chipColor : "default"}
                icon={<NotificationsActiveRoundedIcon />}
                label={alertOnLabel(route)}
              />
            ) : (
              <Chip
                size="small"
                variant="outlined"
                icon={<NotificationsNoneRoundedIcon />}
                label="Alerts off"
                sx={{ ...MUTED_CHIP_SX, "& .MuiChip-icon": { color: "text.disabled" } }}
              />
            )}
          </SpecValue>

          <RouteFilterChips route={route} />
        </Stack>

        {/* Eats the slack, so the actions sit at the right edge however wide the
            spec runs — and on a wrap they lead the second line rather than
            trailing whatever fell there. */}
        <Box sx={{ flex: "1 1 0", minWidth: 0 }} />

        {/* How stale the pane under this header is, answered by ONE clock for
            both of the things that can search it — see `searchedLabel`.
            Warning ink when nothing ever has, which is the rail's word for that
            state ("unsearched") said at the route you actually have open. */}
        <SpecValue help={searchedHelp(route)}>
          <Typography
            variant="caption"
            color={route.last_checked_at ? "text.secondary" : "warning.main"}
            sx={{ whiteSpace: "nowrap" }}
          >
            {searchedLabel(route)}
          </Typography>
        </SpecValue>

        {/* Four labelled buttons. On a phone they take a full-width line of
            their own rather than being dealt out one per line by the parent's
            wrap — `flexWrap` inside this Stack then packs them two-up, which is
            what fits. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            width: { xs: "100%", md: "auto" },
          }}
        >
          {actions}
        </Stack>
      </Stack>
    </Box>
  );
}
