import { Box, Chip, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import NotificationsNoneRoundedIcon from "@mui/icons-material/NotificationsNoneRounded";
import { ALERT_HEALTH, alertHealth } from "../../lib/alerts";
import { ROUTE_DIAGRAM_WIDTH } from "./constants";
import { AlertStateChip } from "../../components/AlertStateChip";
import { BookableCurrencies, CabinChip } from "../../components/brand";
import { parseCodeList } from "../../lib/routeShape";
import { RouteDiagram } from "./RouteDiagram";
import { ALERTS_OFF_HELP, alertHelp, alertOnLabel } from "./alertCopy";
import { dayCount } from "./labels";
import { usDate } from "./dates";
import type { RouteField } from "./form";
import type { AirportName, AlertScheduleRoute, TrackedRoute } from "../../api";

/**
 * One field of the header's spec, as a bare value.
 *
 * There used to be an overline label above each of these, which is what made a
 * row of chips a legible record of choices — and what made the header two rows
 * tall. The label became the tooltip: the values are self-describing (a date
 * range, cabin chips, card marks) and the sentence explaining each is one hover
 * away, on the value itself rather than on a caption above it.
 */
function SpecValue({
  help,
  onClick,
  children,
}: {
  help: string;
  /** Makes the value a shortcut into the edit dialog, landing on the field it
   *  states. Every value here IS a form field, so the header doubles as the
   *  form's table of contents — you read a setting and touch it in one move,
   *  instead of opening a dialog of thirteen controls and finding it again. */
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip
      title={
        onClick ? (
          <>
            {help}
            <Box component="span" sx={{ display: "block", mt: 0.5, opacity: 0.75 }}>
              Click to edit.
            </Box>
          </>
        ) : (
          help
        )
      }
      placement="bottom-start"
    >
      <Box
        // A Box with a role, never a `<button>`: MUI `Chip` renders a `div`, and
        // a div inside a button is invalid HTML that browsers reflow around.
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        sx={{
          minWidth: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          alignItems: "center",
          cursor: onClick ? "pointer" : "help",
          // Negative margin against the padding, so the hover ground has room
          // around the value without widening the row when nothing is hovered —
          // this strip is sticky and must not move as the pointer crosses it.
          ...(onClick && {
            px: 0.5,
            mx: -0.5,
            py: 0.25,
            my: -0.25,
            transition: "background-color 120ms",
            "&:hover": { bgcolor: (t: Theme) => t.spec.hover },
            "&:focus-visible": {
              outline: "1px solid",
              outlineColor: (t: Theme) => t.spec.indicator,
              outlineOffset: 0,
            },
          }),
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

/**
 * The selected route's header: what this route is, and the controls that act
 * on it, on one line.
 *
 * ONE ROW, and it stays put. It was two tiers — identity above, a labelled
 * six-cell spec grid below — which cost about 120px of the pane before a single
 * find, and scrolled away the moment you read past the first page of results.
 * A sticky band only earns its height once, so it has to be short: the spec is
 * still all here, but as bare values with their labels moved into tooltips, and
 * the two cells that were neither identity nor filter are gone. Search cost
 * belongs to the button that spends it (and to the Edit dialog, which still
 * quotes it); "last searched" is per-find in the table below and per-route in
 * the rail. The find count is gone for the same reason — the rail already
 * counts every route, including this one.
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
  actions: React.ReactNode;
}) {
  const cabins = parseCodeList(route.cabins);
  const currencies = parseCodeList(route.currencies);
  const days = dayCount(route.date_start, route.date_end);
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
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ px: { xs: 1.5, sm: 2.5 }, py: 1, alignItems: "center", flexWrap: "wrap" }}
      >
        {/* Back to the list, and only below `md` — above it the list is already
            on screen to the left, so this would be a button that undoes nothing.
            Hidden with `sx` rather than a second `useIsNarrow`: it is genuinely
            just visibility, and it sits inside a header that is already sticky,
            so it is reachable from anywhere in a long page of finds. */}
        <IconButton
          size="small"
          aria-label="All routes"
          onClick={onBack}
          sx={{ display: { xs: "inline-flex", md: "none" }, flexShrink: 0, ml: -0.5 }}
        >
          <ArrowBackRoundedIcon fontSize="small" />
        </IconButton>

        {/* A FIXED width, so the spec and the buttons sit at the same x on every
            route. The diagram's natural width tracks how many airports the route
            watches and which way it runs, so left to size itself it moved the
            whole rest of the header sideways every time you picked a different
            route in the rail — the one motion a header you are scanning down a
            list with must not have. Wide enough for two airports a side; a 3×3
            route wraps inside the box rather than pushing anything. */}
        <Box sx={{ width: { xs: "auto", sm: ROUTE_DIAGRAM_WIDTH }, flexShrink: 0 }}>
          <RouteDiagram route={route} names={names} onEditSide={onEdit} />
        </Box>

        {/* The spec, unlabelled. Every value keeps the help text its overline
            used to carry, so nothing about the route became unexplained — only
            unlabelled, which is what buys the row back. */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
        >
          <SpecValue
            help="The departure dates this route watches."
            onClick={() => onEdit("dateStart")}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {usDate(route.date_start)} – {usDate(route.date_end)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              {days}d
            </Typography>
          </SpecValue>

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

          <SpecValue
            help="Cabins. Results outside these are stored, just not shown here."
            onClick={() => onEdit("cabins")}
          >
            {cabins.length > 0 ? (
              cabins.map((c) => <CabinChip key={c} cabin={c} />)
            ) : (
              <Chip size="small" variant="outlined" label="Any cabin" />
            )}
          </SpecValue>

          {currencies.length > 0 && (
            <SpecValue
              help="Cards: only space bookable with these — by transfer, or by buying the cash fare through that card's portal."
              onClick={() => onEdit("currencies")}
            >
              <BookableCurrencies json={route.currencies ?? undefined} size={20} />
            </SpecValue>
          )}

          {/* Constraints, and only when they constrain. An unset filter is the
              default reading of a row that doesn't mention it, and two "Any"
              chips in a sticky strip are two chips of nothing. */}
          {route.direct_only ? (
            <SpecValue
              help="Nonstop-only filters what this route SHOWS. Connecting itineraries are still gathered and still stored, so turning it off brings them straight back — no search, no API call."
              onClick={() => onEdit("directOnly")}
            >
              <Chip size="small" color="info" variant="outlined" label="Nonstop" />
            </SpecValue>
          ) : null}

          {(route.min_seats ?? 1) > 1 && (
            <SpecValue
              help="Finds with fewer seats than this are hidden here."
              onClick={() => onEdit("minSeats")}
            >
              <Chip size="small" variant="outlined" label={`${route.min_seats}+ seats`} />
            </SpecValue>
          )}

          {/* Alerts, and — alone on this row — stated even when OFF.
              Everything else here is a filter, whose absence reads correctly as
              "not filtered"; alerts are a whole feature, and a route that isn't
              enrolled looks exactly like an app that doesn't have them. This
              muted chip is the only place the Routes page says otherwise, and
              it is one click from turning them on. */}
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
                sx={{
                  color: "text.disabled",
                  borderColor: "divider",
                  "& .MuiChip-icon": { color: "text.disabled" },
                }}
              />
            )}
          </SpecValue>
        </Stack>

        {/* Eats the slack, so the actions sit at the right edge however wide the
            spec runs — and on a wrap they lead the second line rather than
            trailing whatever fell there. */}
        <Box sx={{ flex: "1 1 0", minWidth: 0 }} />

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
