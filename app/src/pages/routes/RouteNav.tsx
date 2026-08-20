import {
  Badge,
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import NotificationsNoneRoundedIcon from "@mui/icons-material/NotificationsNoneRounded";
import { ALERT_HEALTH, alertHealth } from "../../lib/alerts";
import { sinceLabel } from "../../lib/format";
import { RouteFilters } from "./RouteFilters";
import { parseCodes } from "../../lib/routeShape";
import { citySideLabel, dayCount, directionArrow, sideLabel } from "./labels";
import { usDate } from "./dates";
import { RAIL_MAX_WIDTH } from "./constants";
import type { AirportName, AlertScheduleRoute, Find, TrackedRoute } from "../../api";

/** A route's shape in one line, for a rail row: `SEA/PDX → NRT/HND`, with the
 *  cities under it once the airport lookup has landed. The rail is narrow, so
 *  this is the CITY and never the airport's full name — "Seattle–Tacoma
 *  International Airport/Portland International Airport" is one ellipsis. The
 *  full name lives on the header's pills, where there is room for it. */
function RailRoute({
  route,
  names,
  mark,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** Sits immediately right of the CODES, on their own line. As a sibling of
   *  this whole block it would sit past the widest of the two lines — and the
   *  city line under `SEA/PDX ⇄ NRT/HND` is much the wider — so the mark would
   *  float in the middle of the row, attached to nothing. */
  mark?: React.ReactNode;
}) {
  const origins = parseCodes(route.origins, route.origin);
  const destinations = parseCodes(route.destinations, route.destination);
  // Suppressed wholesale until something resolved: every unresolved code falls
  // back to itself, so a half-empty map would print the code line twice.
  const known = [...origins, ...destinations].some((c) => names.has(c));

  return (
    <Box sx={{ minWidth: 0 }}>
      {/* A flex row rather than the mark inline INSIDE the Typography: that
          line is `noWrap`, so a wide route would ellipsise its own status
          icon away. Here the codes shrink and the mark does not. */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
        <Typography
          component="div"
          noWrap
          sx={{
            fontWeight: 700,
            letterSpacing: 0.3,
            lineHeight: 1.35,
            minWidth: 0,
          }}
        >
          {sideLabel(route.origins, route.origin)}
          <Box component="span" sx={{ color: "text.disabled", mx: 0.6, fontWeight: 400 }}>
            {directionArrow(route)}
          </Box>
          {sideLabel(route.destinations, route.destination)}
        </Typography>
        {mark}
      </Box>
      {known && (
        <Typography
          variant="caption"
          color="text.disabled"
          noWrap
          sx={{ display: "block", fontSize: 10.5, lineHeight: 1.4 }}
        >
          {citySideLabel(route.origins, route.origin, names)}
          <Box component="span" sx={{ mx: 0.5 }}>
            {directionArrow(route)}
          </Box>
          {citySideLabel(route.destinations, route.destination, names)}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The route rail: every monitored route, with the window and filters that define
 * it and the number of finds currently sitting inside them.
 *
 * This replaced a column of accordions. The finds table is tall — an itinerary
 * per row — so stacking routes vertically meant one route's results pushed the
 * next route's heading off the screen, and reading any of them started with
 * folding the others. Selection does that for free, and the rail keeps every
 * route's shape visible while you read one of them.
 *
 * The entries are flush rows divided by a hairline — cells of a one-column
 * table, not a stack of cards. They were cards, and at a handful of routes that
 * was four nested borders' worth of chrome to say "these are separate things",
 * which a single rule says quietly. Selection still gets a tint and the accent
 * bar, so it never depends on the divider it doesn't own.
 */
/**
 * The rail's alerts mark: one 14px bell, tinted by how the route's sweep is
 * going.
 *
 * Two states and no more: **yellow is armed, red is broken.** At 14px with no
 * label beside it a five-way tint is unreadable, so the detail is in the
 * tooltip and the silhouette only answers "should I be worried".
 *
 * Falls back to plain yellow whenever there is no schedule row — the shell's
 * poll not landed yet, the query refused, or a route enrolled seconds ago and
 * not yet in the server's answer. "Alerts are on" is known from the route itself
 * and must never blink; only the tint and the tooltip are conditional.
 */
function RailAlertBell({ alert }: { alert?: AlertScheduleRoute }) {
  const state = alert ? ALERT_HEALTH[alertHealth(alert)] : undefined;
  // An OUTLINE bell for a route that is armed but deliberately silent, so
  // "baseline pending" is legible without a chip. See docs/ALERTS.md §5.
  const Icon =
    alert && alertHealth(alert) === "baseline"
      ? NotificationsNoneRoundedIcon
      : NotificationsActiveRoundedIcon;
  return (
    <Tooltip title={state?.help ?? "Alerts on — re-searched automatically"}>
      <Icon
        fontSize="inherit"
        aria-label={state ? `Alerts: ${state.label}` : "Alerts on"}
        sx={{ flexShrink: 0, color: state?.iconColor ?? "warning.main", fontSize: 14 }}
      />
    </Tooltip>
  );
}

/**
 * What a rail row's chip is counting, which is NOT the same thing for the two
 * kinds of route.
 *
 * A one-way route's chip counts stored finds — each row of its table is one
 * bookable answer. A round-trip route's counts PAIRS, because that route's pane
 * never offers a single leg: its finds are one-way legs and what you choose from
 * is the join over both directions. `roundTrip` is carried so the tooltip can
 * say which of the two a number is; the label is the bare number either way,
 * because the rail has no room for a unit.
 */
export interface RouteCount {
  found: number;
  roundTrip: boolean;
  /**
   * Journeys stitched from OTHER routes' legs, for a route the sources hold no
   * market on.
   *
   * Counted separately and never added to `found`, because it is a weaker kind
   * of answer: a journey is two award bookings this app joined at read time, not
   * one seat somebody is selling. It earns its own chip for the reason the
   * `unsearched` one exists — a route reading `0` is otherwise the only signal,
   * and nobody opens a route that says it has nothing.
   */
  viaJourneys?: number;
}

export function RouteNav({
  routes,
  counts,
  names,
  alerts,
  selectedId,
  onSelect,
  onAdd,
  onDelete,
  deletingId,
}: {
  routes: TrackedRoute[];
  counts: Map<number, RouteCount>;
  /** The same lookup the header's pills read, so the rail and the detail pane
   *  can't name one airport two ways. */
  names: Map<string, AirportName>;
  /** Alert HEALTH by route id, from `GET /api/alerts/schedule`. Empty until the
   *  shell's poll lands, and it never holds a route whose alerts are off — so
   *  a missing entry is normal, not an error. */
  alerts: Map<number, AlertScheduleRoute>;
  selectedId?: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
  /** Opens the removal confirmation for a row. The rail never deletes anything
   *  itself — a 14px target one click from an undo-less action has to go
   *  through the same dialog the header's button used to open. */
  onDelete: (route: TrackedRoute) => void;
  /** The route whose delete is in flight, so its button can't be pressed twice. */
  deletingId?: number;
}) {
  return (
    // The sidebar. Not a `Paper` any more, and that is the whole change: a card
    // has an edge on all four sides and a gap around it, while a sidebar has ONE
    // edge — the rule it shares with the editor — and runs the full height of
    // the window. It reads as a separate pane because it is painted in
    // `background.chrome`, the same ground as the tab strip and every table
    // head, which is exactly the relationship VS Code's sidebar has to its
    // editor.
    <Box
      sx={{
        bgcolor: "background.chrome",
        // `ruleSoft`, not `divider`: the change of ground between this pane and
        // the editor is already the separation, so the line only has to confirm
        // it. A full-weight rule here read as a seam holding two halves apart
        // rather than as one surface meeting another.
        borderRight: { md: "1px solid" },
        borderBottom: { xs: "1px solid", md: "none" },
        borderColor: "ruleSoft",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        // Lets the grid's `fit-content()` cap actually clamp this column: the
        // rail's `noWrap` route lines would otherwise set a min-content floor
        // that no maximum can lower.
        minWidth: 0,
      }}
    >
      {/* The sidebar's section header, in VS Code's own idiom: small, spaced,
          uppercase, with its one action at the right. `useFlexGap`, so the
          New button's `ml: auto` actually reaches that edge — Stack's
          default `spacing` is a margin-left on every child but the first,
          and that margin outranks `auto`. `py: 1` and an unshrunk
          `size="small"` button match `RouteHeader`'s own row exactly — same
          padding, same button, so the two headers' bottom rules land on one
          line across the sidebar/editor seam.

          Painted `background.default`, NOT the sidebar's own `background.chrome`
          — that is the PAGE colour, the same one `RouteHeader` sits on and the
          same one `NavLink`'s active tab paints itself (router.tsx). Without
          this the header read as part of the chrome rail underneath it rather
          than as the top edge of the open Routes tab; now the tab strip, this
          header and the editor's header are one continuous plane of the same
          colour, with only the rail's list below it left on the chrome ground. */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{
          px: 1.5,
          py: 1,
          alignItems: "center",
          flexShrink: 0,
          bgcolor: "background.default",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
          Routes
        </Typography>
        <Chip
          size="small"
          label={routes.length}
          // `accentMuted` + `secondary` (the accent as INK): `primary.main` is
          // now the accent as a GROUND and far too dark to set type in.
          sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }}
        />
        {/* Outlined success, the same green as a route's find count below it:
            adding a route is the one thing this header does, and the colour it
            already means in this column is "there is something here". */}
        <Tooltip title="Track a new route">
          <Button
            size="small"
            variant="outlined"
            color="success"
            onClick={onAdd}
            startIcon={<AddRoundedIcon fontSize="small" />}
            sx={{ ml: "auto" }}
          >
            New
          </Button>
        </Tooltip>
      </Stack>
      {/* The list scrolls, the header does not — a sidebar's title stays put
          while its contents move, and this is the pane's own scrollbar rather
          than the window's. */}
      {/* Its own scrollbar at EVERY width now, not just from `md` up: below that
          this pane is the whole screen rather than a stacked block, so the list
          scrolling itself is what a list screen does. */}
      <List disablePadding sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {routes.map((r) => {
          const count = counts.get(r.id);
          const found = count?.found ?? 0;
          return (
            <ListItemButton
              key={r.id}
              // `li`, because the default `div` inside `List`'s `ul` is
              // invalid HTML.
              component="li"
              selected={r.id === selectedId}
              onClick={() => onSelect(r.id)}
              sx={{
                display: "block",
                position: "relative",
                px: 2,
                py: 1.25,
                // One rule between rows and none under the last, so the rail
                // ends on its own edge rather than a stray line.
                borderBottom: "1px solid",
                borderColor: "divider",
                "&:last-of-type": { borderBottom: "none" },
                transition: "background-color 120ms",
                // The accent bar is a pseudo-element rather than a border, so
                // selecting a row doesn't reflow its text by 3px.
                "&::before": {
                  content: '""',
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  bgcolor: (t) => t.spec.indicator,
                  opacity: 0,
                  transition: "opacity 120ms",
                },
                // The palette's own selection ground, not a wash of the accent —
                // but the QUIET one, paired with the bright bar above. A row
                // here carries a cabin chip, up to three airline marks and a
                // green find count, and `spec.selected` (a saturated fill meant
                // for rows of plain text) turns every one of them to mush. Bar
                // plus quiet ground is unambiguous and costs no information.
                "&.Mui-selected, &.Mui-selected:hover": {
                  bgcolor: (t) => t.spec.selectedIdle,
                },
                "&.Mui-selected::before": { opacity: 1 },
              }}
            >
              {/* `useFlexGap`, so the count chip's `ml: auto` actually reaches
                  the right edge: Stack's default `spacing` is a margin on every
                  child but the first, and it outranks `auto`. */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center" }}>
                {/* A route IS its shape: the pair, the window, the filters. That
                    is the one thing the rail is for — telling two SEA→NRT routes
                    apart at a glance — and a free-text label sat above it saying
                    nothing about geography. */}
                {/* A route that re-searches itself and emails you is spending
                    the metered allowance without anyone pressing anything, so
                    the rail says which ones do — and, when the schedule has
                    landed, whether they are working. A failing sweep sends no
                    email about itself (docs/ALERTS.md §1), so this bell is one
                    of the few places you would ever notice.

                    It rides on the CODES line rather than beside this whole
                    block, so it reads as a mark on the route's name. One icon
                    and a tooltip is the whole budget: the row already carries
                    two lines of label, a cabin chip, card marks and a count. */}
                <Box sx={{ minWidth: 0 }}>
                  <RailRoute
                    route={r}
                    names={names}
                    mark={r.alerts_enabled === 1 ? <RailAlertBell alert={alerts.get(r.id)} /> : null}
                  />
                </Box>
                <Box sx={{ ml: "auto", flexShrink: 0, display: "flex", alignItems: "center", gap: 0.5 }}>
                  {found > 0 ? (
                    // The number alone can't say what it counts, and the two
                    // kinds of route count different things — see `RouteCount`.
                    <Tooltip
                      title={
                        count?.roundTrip
                          ? `${found} round trip${found === 1 ? "" : "s"} — pairs of a stored outbound and return, not single legs`
                          : `${found} find${found === 1 ? "" : "s"} stored in this window`
                      }
                    >
                      <Chip size="small" variant="outlined" color="success" label={found} />
                    </Tooltip>
                  ) : (
                    // "Nobody has looked" and "looked, nothing there" are
                    // different answers, and the rail is where you notice.
                    !r.last_checked_at && (
                      <Chip size="small" variant="outlined" color="warning" label="unsearched" />
                    )
                  )}
                  {/* Its own chip beside the find count, never folded into it: a
                      journey is two bookings joined at read time, not a seat
                      anybody sells as one. Without it a route that seats.aero
                      holds no market on reads `0` forever and nobody opens it. */}
                  {count?.viaJourneys ? (
                    <Tooltip
                      title={`${count.viaJourneys} way${count.viaJourneys === 1 ? "" : "s"} to get there with a stop, built from legs your other routes found — separate awards, not one booking`}
                    >
                      <Chip
                        size="small"
                        variant="outlined"
                        color="secondary"
                        label={`${count.viaJourneys} via`}
                      />
                    </Tooltip>
                  ) : null}
                </Box>
                {/* Removal lives on the row it removes, at icon weight, in
                    the top-right CORNER of the row rather than in the line of
                    chips beside it.

                    It was a labelled Remove button in the editor's header,
                    beside Search and Edit — which made it the third full-weight
                    control on the pane you are reading, and it could only ever
                    act on the route already open. Here it reaches any route
                    without selecting it first, and the dialog behind it is
                    unchanged: this is a smaller target for the same two-step
                    action, not a faster one.

                    Negative margins rather than `position: absolute`, so it
                    still takes its own width in the flex row: the count chips
                    shrink away from it instead of being painted over. They pull
                    it into the row's own `px: 2` / `py: 1.25` padding, which is
                    what puts it in the corner of the rectangle rather than
                    inset from it.

                    `stopPropagation`, because the row is itself a button:
                    without it a click would select the route on the way to
                    opening the dialog, and cancelling would leave you on a
                    route you never asked to open. */}
                <Tooltip title="Remove this route">
                  <span style={{ alignSelf: "flex-start" }}>
                    <IconButton
                      size="small"
                      aria-label={`Remove ${sideLabel(r.origins, r.origin)} ${directionArrow(r)} ${sideLabel(r.destinations, r.destination)}`}
                      disabled={deletingId === r.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(r);
                      }}
                      sx={{
                        p: 0.25,
                        mt: -0.75,
                        mr: -1.25,
                        // Quiet until pointed at: it sits in a row whose job is
                        // to be read, and the only destructive control on the
                        // page should not be the brightest thing in it.
                        color: "text.disabled",
                        "&:hover": { color: "error.light", bgcolor: "transparent" },
                      }}
                    >
                      <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.25 }}
              >
                {usDate(r.date_start)} – {usDate(r.date_end)}
                <Box component="span" sx={{ color: "text.disabled" }}>
                  {" · "}
                  {dayCount(r.date_start, r.date_end)}d
                </Box>
              </Typography>
              <Box sx={{ mt: 0.75 }}>
                <RouteFilters route={r} />
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}
