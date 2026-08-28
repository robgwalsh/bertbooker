import { useMemo, useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Divider,
  Paper,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import type { AirportName, Find, TrackedRoute } from "../../api";
import { FindProgram, TripTotalCost } from "./findCells";
import { pairKey } from "./findKey";
import { findStops, ItineraryCard } from "./Itinerary";
import { RouteMapFill, ROUTE_MAP_CELL_WIDTH, toRouteStops } from "./RouteMap";
import { isSamePath, ROUTE_ALT_COLOR, ROUTE_COLOR } from "../../lib/routeMapGeometry";
import { routeSets } from "../../lib/routeShape";
import { useAirportNames } from "../../hooks/useAirportNames";
import {
  DEFAULT_MAX_NIGHTS,
  DEFAULT_MIN_NIGHTS,
  MAX_NIGHTS,
  MAX_NIGHTS_SPAN,
  pairRoundTrips,
  splitDirections,
  windowNightsFor,
  type RoundTripPair,
  type RoundTripResult,
} from "../../lib/roundtrip";
import { BookableCurrencies, CabinChip } from "../../components/brand";
import { DATE_CELL_WIDTH } from "../../lib/layout";
import { dayLabel, dollars, miles, sinceLabel } from "../../lib/format";
import { useIsPhone } from "../../hooks/useBreakpoints";

// What a ROUND-TRIP route's pane shows in place of the flat finds table: which
// combinations of a stored outbound and a stored return are N-M nights apart
// with space in both directions.
//
// Rendered when `round_trip = 1` and never otherwise — there is no view toggle,
// because round trip is a property of the route (stated in the route header,
// changed in the Edit dialog) and a toggle would let the reading disagree with
// the setting. This component may therefore assume the flag is on.
//
// It gathers nothing and spends nothing. Every leg on screen is a find the flat
// table would already show; the work is the join.
//
// The totals are SUMS OF TWO ONE-WAYS and every surface here says so. seats.aero
// quotes one-way costs and this app stores nothing else, so where a program
// prices round trips on its own chart the real number can be lower — a discount
// that lives in the airline's booking engine and is invisible from here.

/** Rows carry two itineraries, so they are roughly twice a finds row's height. */
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/** MUI's Alert action slot shrinks to whatever is left, which wraps a button
 *  label onto three lines. These states are the point of the pane, so their one
 *  action stays on one line and keeps its width.
 *
 *  The margin is here rather than on a wrapper because an Alert is the one thing
 *  in this pane that SHOULD float: it is a message about the pane, not another
 *  band of it, and a full-bleed alert reads as chrome. */
const ALERT_SX = {
  m: 2,
  "& .MuiAlert-action": { alignItems: "center", pt: 0, flexShrink: 0 },
  "& .MuiAlert-action .MuiButton-root": { whiteSpace: "nowrap" },
} as const;

export interface RoundTripTableProps {
  route: TrackedRoute;
  finds: Find[];
  /**
   * The trip-length filter in nights, or `null` for the whole-window trip — out
   * on the window's first day, back on its last.
   *
   * `null` is the default and is what an absent `minNights`/`maxNights` in the
   * URL means — the two states are the same state, so there is no third param to
   * keep in step with them. Both readings are pure reads over stored legs;
   * nothing here changes what a search gathers.
   */
  nights: [number, number] | null;
  onNightsChange: (nights: [number, number] | null) => void;
  /** Run a search. Turning round trip on gathers nothing by itself. */
  onSearch: (id: number) => void;
  searching?: boolean;
  /** Draw the Map column. **Defaults on**, and moves with the finds table's
   *  `showMap` — the two tables share a column order, so a column optional in
   *  one and fixed in the other is how they stop reading alike. */
  showMap?: boolean;
}

const sideLabel = (codes: string[]) => codes.join("/") || "?";

/** What the return direction is called, for the states that have to name it. */
function reverseLabel(r: TrackedRoute): string {
  const { origins, destinations } = routeSets(r);
  return `${sideLabel(destinations)}→${sideLabel(origins)}`;
}

/** Per-leg cells sit at the top of their row; the straddling ones are centred on
 *  the pair. Matches the finds table's `verticalAlign: "top", pt: 2`. */
const LEG_CELL = { verticalAlign: "top", pt: 2 } as const;

/** The Date column, pinned to the same constant the one-way table uses — the two
 *  run the same columns in the same order, so a date column that is one width
 *  here and another there is the one thing that would stop them reading alike.
 *  `width` under `table-layout: auto` is only a suggestion; the min/max pair is
 *  what holds it still as you switch routes. See `DATE_CELL_WIDTH`. */
const DATE_CELL = {
  whiteSpace: "nowrap",
  width: DATE_CELL_WIDTH,
  minWidth: DATE_CELL_WIDTH,
  maxWidth: DATE_CELL_WIDTH,
} as const;

/**
 * One trip, as TWO table rows — outbound then return, inside their own `tbody`.
 *
 * Real columns cost a second `<tr>` per trip and give this table the same
 * left-to-right alignment as the one-way one — no grid track has to be
 * guessed at, and both tables run Date → Itinerary → Map → Cabin → Program →
 * … → Cost → Book with.
 *
 * What is true of the TRIP rather than of one leg straddles both rows with
 * `rowSpan={2}`: the map (a round trip is one journey), the cabin (pairing
 * requires both legs to match), the nights, the seats, the total. What is
 * per-leg stays per-leg — and `Book with` is deliberately one of those: you may
 * pay for the two legs with different cards, so a merged chip would assert
 * something no program guarantees.
 *
 * A `tbody` per trip rather than four loose rows: it is what makes the pair one
 * hover target and lets the divider fall between trips instead of between a
 * trip's own two halves.
 */
function PairRow({
  p,
  airports,
  showMap,
}: {
  p: RoundTripPair;
  airports: Map<string, AirportName>;
  showMap: boolean;
}) {
  // ONE map for the trip, not one per leg. Both legs are plotted on it, but only
  // as two lines when they actually differ — the usual return retraces the
  // outbound exactly, and drawing that twice is the same picture twice.
  const out = toRouteStops(findStops(p.outbound), airports);
  const back = toRouteStops(findStops(p.inbound), airports);
  const paths = isSamePath(out, back)
    ? [{ stops: out }]
    : [
        { stops: out, color: ROUTE_COLOR, label: "Out" },
        { stops: back, color: ROUTE_ALT_COLOR, label: "Back" },
      ];

  // The straddling cells' own alignment: centred against two itinerary cards.
  const spanCell = { verticalAlign: "middle" } as const;

  return (
    <TableBody
      sx={{
        "&:hover td": { bgcolor: (t) => t.palette.action.hover },
        // The divider belongs BETWEEN trips, not between a trip's own two rows.
        // Only the cells that stop at row one, though: a `rowSpan={2}` cell's
        // bottom edge already IS the bottom of the trip, and clearing it too
        // left the rule broken into segments across the straddling columns.
        "& tr:first-of-type td:not([rowspan])": { borderBottom: "none" },
      }}
    >
      <TableRow>
        <TableCell sx={{ ...LEG_CELL, ...DATE_CELL }}>
          {/* The direction, then the date exactly as the finds table sets it.
              The label is not decoration: with the two legs stacked as rows
              there is otherwise nothing saying which one is the way home. */}
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            Out
          </Typography>
          {dayLabel(p.outbound.flight_date)}
        </TableCell>
        <TableCell sx={{ minWidth: 340 }}>
          <ItineraryCard f={p.outbound} />
        </TableCell>
        {/* Straddles both legs, and takes its height from them: the cell is the
            two itinerary cards tall, and `RouteMapFill` fills exactly that.
            Nothing here can stretch the pair — see RouteMapFill for why the
            cell is `position: relative` with no padding of its own. */}
        {showMap && (
          <TableCell
            rowSpan={2}
            sx={{
              position: "relative",
              p: 0,
              width: ROUTE_MAP_CELL_WIDTH,
              minWidth: ROUTE_MAP_CELL_WIDTH,
            }}
          >
            <RouteMapFill paths={paths} />
          </TableCell>
        )}
        <TableCell rowSpan={2} sx={spanCell}>
          <CabinChip cabin={p.cabin} />
        </TableCell>
        <TableCell sx={LEG_CELL}>
          <FindProgram f={p.outbound} />
        </TableCell>
        <TableCell rowSpan={2} align="right" sx={spanCell}>
          {p.nights}
        </TableCell>
        <TableCell rowSpan={2} align="right" sx={spanCell}>
          <Tooltip
            title={`The lower of the two legs (out ${p.outbound.seats_available}, back ${p.inbound.seats_available}) — a trip needs seats both ways.`}
          >
            <span>{p.seats}</span>
          </Tooltip>
        </TableCell>
        <TableCell rowSpan={2} align="right" sx={{ ...spanCell, whiteSpace: "nowrap" }}>
          <TripTotalCost p={p} />
        </TableCell>
        <TableCell sx={LEG_CELL}>
          <BookableCurrencies json={p.outbound.transfer_currencies} />
        </TableCell>
      </TableRow>

      <TableRow>
        <TableCell sx={{ ...LEG_CELL, ...DATE_CELL }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            Back
          </Typography>
          {dayLabel(p.inbound.flight_date)}
        </TableCell>
        <TableCell sx={{ minWidth: 340 }}>
          <ItineraryCard f={p.inbound} />
        </TableCell>
        <TableCell sx={LEG_CELL}>
          <FindProgram f={p.inbound} />
        </TableCell>
        <TableCell sx={LEG_CELL}>
          <BookableCurrencies json={p.inbound.transfer_currencies} />
        </TableCell>
      </TableRow>
    </TableBody>
  );
}

/**
 * One trip on a phone.
 *
 * The `rowSpan={2}` structure converts more directly than it looks, because the
 * straddling cells are exactly the trip-level facts: cabin, nights, seats and
 * the total become a heading, and the two legs become two blocks under it. The
 * per-leg things stay per-leg for the same reason they are per-leg in the table
 * — you may pay for the two halves with different cards, so `Book with` is
 * printed twice on purpose.
 *
 * As in `FindCard`, the map does not come along: it is the one cell that is a
 * fixed-width picture rather than a fact.
 */
function PairCard({ p }: { p: RoundTripPair }) {
  return (
    // Its own horizontal inset, for the same reason as `FindCard`: the table
    // cells were what held the content off the edge.
    <Box sx={{ px: 2, py: 1.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 1 }}
      >
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <CabinChip cabin={p.cabin} />
          <Typography variant="body2" color="text.secondary">
            {p.nights} night{p.nights === 1 ? "" : "s"}
          </Typography>
          {/* The same explanation the table's straddling cell carries: a trip
              needs seats in both directions, so the pair's number is the lower
              of the two and not a sum. */}
          <Tooltip
            title={`The lower of the two legs (out ${p.outbound.seats_available}, back ${p.inbound.seats_available}) — a trip needs seats both ways.`}
          >
            <Typography variant="body2" color="text.secondary" sx={{ cursor: "help" }}>
              {p.seats} seat{p.seats === 1 ? "" : "s"}
            </Typography>
          </Tooltip>
        </Stack>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <TripTotalCost p={p} />
        </Box>
      </Stack>

      <TripLeg label="Out" f={p.outbound} />
      <TripLeg label="Back" f={p.inbound} />
    </Box>
  );
}

/** One direction of a trip card. The label is not decoration — with the legs
 *  stacked there is otherwise nothing saying which one is the way home. */
function TripLeg({ label, f }: { label: string; f: Find }) {
  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ width: 34, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          {label}
        </Typography>
        <Typography variant="body2">{dayLabel(f.flight_date)}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {f.program}
        </Typography>
      </Stack>
      <Box sx={{ pl: "42px" }}>
        <ItineraryCard f={f} />
        <Box sx={{ mt: 0.5 }}>
          <BookableCurrencies json={f.transfer_currencies} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Why the whole-window trip missed — and it is three different misses, which is
 * the whole reason this mode reports `departDateSlots`/`returnDateSlots`.
 *
 * "Nothing flies out on the first day" is a fact about one date and is fixed by
 * moving the window or asking a shorter question; "both days have legs but they
 * don't join up" is a fact about airports and cabins and is fixed by neither.
 * Collapsing them into "nothing pairs" (which is what a nights-range reading
 * could only ever say) leaves you re-searching a route that has the data.
 */
function WholeWindowMiss({ route, result }: { route: TrackedRoute; result: RoundTripResult }) {
  const noOut = result.departDateSlots === 0;
  const noBack = result.returnDateSlots === 0;
  const first = <strong>{dayLabel(route.date_start)}</strong>;
  const last = <strong>{dayLabel(route.date_end)}</strong>;
  if (noOut && noBack)
    return (
      <>
        none of them fly on the two days this trip needs — nothing out on {first}, nothing back on{" "}
        {last}. Those dates hold no space in either direction.
      </>
    );
  if (noOut)
    return (
      <>
        none of the outbound ones leave on {first}. There is space coming back on {last}, so it is
        the departure day that is empty.
      </>
    );
  if (noBack)
    return (
      <>
        none of the return ones leave on {last}. There is space going out on {first}, so it is the
        return day that is empty.
      </>
    );
  // Both anchor dates hold legs, so the miss is structural: a return has to
  // leave from the airport its outbound landed at, in the same cabin.
  return (
    <>
      both {first} and {last} hold space, but no pair of them makes one trip — a return has to leave
      from where the outbound landed, in the same cabin. Different airports, or different cabins.
    </>
  );
}

export function RoundTripTable({
  route,
  finds,
  nights: nightsProp,
  onNightsChange,
  onSearch,
  searching,
  showMap: showMapProp,
}: RoundTripTableProps) {
  // Cards on a phone — see `useIsPhone`. The `rowSpan` layout below is exactly
  // the thing a CSS-only responsive table cannot carry, which is why this is a
  // branch and not a stylesheet.
  const narrow = useIsPhone();
  // Never on a phone: `PairCard` draws no map, so asking for one would only buy
  // a coordinate lookup nothing renders. Same rule as `FindsTable`.
  const showMap = !narrow && showMapProp !== false;
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // Local while dragging; committed to the URL on release, so one drag is one
  // history entry rather than fifty.
  const [draft, setDraft] = useState<[number, number] | null>(null);

  // The whole-window trip's length, for the copy to quote. The default mode does
  // not filter BY it — it names the window's two endpoint dates and asks whether
  // that one trip is bookable, which is the question a route whose window is your
  // actual travel dates is really asking.
  const windowNights = windowNightsFor(route);
  const custom = nightsProp != null;
  const [minNights, maxNights] = nightsProp ?? [0, windowNights];

  const result = useMemo(() => {
    // One route holds both directions: its search put every airport on both
    // sides of a single seats.aero call.
    const { outbound, inbound } = splitDirections(route, finds);
    return pairRoundTrips(
      outbound,
      inbound,
      custom
        ? { mode: "nights", minNights, maxNights, pointLimit: route.point_limit }
        : {
            mode: "dates",
            departOn: route.date_start,
            returnOn: route.date_end,
            pointLimit: route.point_limit,
          },
    );
  }, [route, finds, custom, minNights, maxNights]);

  const searched = route.last_checked_at != null;

  const pageCount = Math.max(1, Math.ceil(result.pairs.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const rows = result.pairs.slice(start, start + pageSize);

  // One coordinate lookup for every airport on the page — both legs of every
  // pair. Scoped to the visible page for the same reason the finds table scopes
  // its own: the paired set can run to hundreds of trips. Skipped entirely when
  // the column is hidden — nothing else here wants coordinates, and the hook
  // no-ops on an empty list.
  const airports = useAirportNames(
    showMap
      ? rows.flatMap((p) => [...findStops(p.outbound), ...findStops(p.inbound)])
      : [],
  );

  const nights = draft ?? [minNights, maxNights];

  return (
    // Full-bleed, like everything else in the editor pane: the trip control is a
    // band under the route header, separated by a rule rather than by a gap. See
    // the Routes page's workbench note.
    <Box>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
        {/* Everything on this band centres on one line: the mode toggle carries
            no caption above it, so nothing makes the first item taller than the
            rest or leaves the buttons hanging low against the copy beside them.
            "Whole window / Custom" says what the control is without a label
            over it. Only one of the two modes is a length; the other is two
            fixed dates, and that distinction rests entirely on the copy beside
            the buttons, which names those dates outright — keep it saying so. */}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={3} sx={{ alignItems: "center" }}>
          <Box sx={{ flexShrink: 0 }}>
            {/* Two different QUESTIONS, not a wide default and a narrow one:
                "the trip that uses this window" names two dates, while a nights
                range floats across every departure the route gathered. Expressing
                the first as `maxNights = windowNights` was the bug — it also
                accepts a departure three days late returning three days past the
                window, which on a route whose window is when you can travel is
                not the trip you asked for. */}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={custom ? "custom" : "window"}
              onChange={(_, v) => {
                if (!v) return; // clicking the active button deselects; keep the mode
                setDraft(null);
                onNightsChange(v === "custom" ? [DEFAULT_MIN_NIGHTS, DEFAULT_MAX_NIGHTS] : null);
              }}
            >
              <ToggleButton value="window" sx={{ textTransform: "none", px: 1.5 }}>
                Whole window
              </ToggleButton>
              <ToggleButton value="custom" sx={{ textTransform: "none", px: 1.5 }}>
                Custom
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
          {custom ? (
            <>
              <Box sx={{ minWidth: 96, flexShrink: 0 }}>
                <Typography variant="subtitle2">
                  {nights[0]}–{nights[1]} nights
                </Typography>
              </Box>
              <Slider
                value={nights}
                min={0}
                max={MAX_NIGHTS}
                step={1}
                marks={[
                  { value: 0, label: "0" },
                  { value: 30, label: "30" },
                  { value: MAX_NIGHTS, label: String(MAX_NIGHTS) },
                ]}
                valueLabelDisplay="auto"
                onChange={(_, v) => {
                  const [a, b] = v as number[];
                  // A slider this wide stops being a trip length and becomes the
                  // other mode; hold the handle rather than letting it drag past
                  // and silently clamp.
                  const lo = a ?? 0;
                  const hi = Math.min(b ?? 0, lo + MAX_NIGHTS_SPAN);
                  setDraft([lo, hi]);
                }}
                onChangeCommitted={() => {
                  if (draft) onNightsChange(draft);
                  setDraft(null);
                }}
                // `flex: 1` is what gives it the rest of the row on a desktop,
                // but a flex basis says nothing in a COLUMN — stacked, the
                // slider would collapse to its own content width. The explicit
                // width is what it needs at `xs`.
                sx={{ flex: 1, width: { xs: "100%", sm: "auto" } }}
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {windowNights === 0 ? (
                // A one-day window. "The 0-night trip" is technically what this
                // is and reads like a bug, so it gets its own sentence.
                <>
                  Out and back on <strong>{dayLabel(route.date_start)}</strong> — this route&rsquo;s
                  window is a single day, so the only trip it can hold is a same-day return.
                </>
              ) : (
                <>
                  Out <strong>{dayLabel(route.date_start)}</strong>, back{" "}
                  <strong>{dayLabel(route.date_end)}</strong> — the {windowNights}-night trip that
                  uses this route&rsquo;s window end to end. Only those two dates; a shorter trip
                  inside the window is a Custom range.
                </>
              )}
            </Typography>
          )}
        </Stack>
      </Box>

      {/* State 1 — round trip is on, but the route has not been searched since.
          The setting alone gathers nothing. */}
      {!searched && (
        <Alert
          severity="warning"
          sx={ALERT_SX}
          action={
            <Button
              size="small"
              variant="contained"
              disabled={searching}
              onClick={() => onSearch(route.id)}
            >
              {searching ? "Searching…" : "Search"}
            </Button>
          }
        >
          <AlertTitle>This route has never been searched</AlertTitle>
          Round trip is on, but the setting only decides what the next search asks for — it fetches
          nothing by itself. An empty result here would mean nothing until you search.
        </Alert>
      )}

      {/* State 2 — searched, and the return direction holds nothing at all.
          Widening the nights range cannot help, so this must not say to. The
          likeliest cause is a search that predates round trip being turned on. */}
      {searched && result.inboundSlots === 0 && (
        <Alert
          severity="info"
          sx={ALERT_SX}
          action={
            <Button size="small" disabled={searching} onClick={() => onSearch(route.id)}>
              {searching ? "Searching…" : "Re-search"}
            </Button>
          }
        >
          <AlertTitle>No {reverseLabel(route)} legs stored</AlertTitle>
          Last searched {sinceLabel(route.last_checked_at)}, and nothing is stored in the return
          direction at all. Widening the trip length will not help. If you turned round trip on after
          that search, this is exactly what you would see — re-search to gather it.
        </Alert>
      )}

      {/* State 3 — legs both ways, but none of them make THIS trip: not this far
          apart in Custom, not on these two dates in whole-window mode. Gated on
          `searched` so it cannot contradict state 1: an unsearched route can
          still have finds under it (stored before the route existed), and
          "widen the range" would be the wrong advice when the answer is
          "search first". */}
      {searched && result.inboundSlots > 0 && result.pairs.length === 0 && (
        <Alert
          severity="info"
          sx={ALERT_SX}
          action={
            // Only in whole-window mode, where the remedy is a different
            // QUESTION rather than a wider one. In Custom the slider is already
            // the control for this and a button beside it would be a second way
            // to do the same thing.
            custom ? undefined : (
              <Button
                size="small"
                onClick={() => onNightsChange([DEFAULT_MIN_NIGHTS, DEFAULT_MAX_NIGHTS])}
              >
                Custom range
              </Button>
            )
          }
        >
          <AlertTitle>
            {custom
              ? `No trips of ${minNights}–${maxNights} nights`
              : `No trip out ${dayLabel(route.date_start)}, back ${dayLabel(route.date_end)}`}
          </AlertTitle>
          {result.outboundSlots} outbound and {result.inboundSlots} return legs are stored, but{" "}
          {custom ? (
            <>
              no combination of them is {minNights}–{maxNights} nights apart. Widen the trip length,
              or switch it to the whole window.
            </>
          ) : (
            <WholeWindowMiss route={route} result={result} />
          )}
        </Alert>
      )}

      {result.pairs.length > 0 && (
        <Box>
          {narrow ? (
            <Stack divider={<Divider />}>
              {rows.map((p, i) => (
                <PairCard key={pairKey(p, start + i)} p={p} />
              ))}
            </Stack>
          ) : (
          <TableContainer>
            <Table size="small">
              {/* Same columns in the same order as the finds table, so the two
                  read alike. `Nights` stands where the one-way table has nothing
                  to say, and `Cost` carries the pair's total rather than a
                  single award's. */}
              <TableHead>
                <TableRow>
                  <TableCell sx={DATE_CELL}>Date</TableCell>
                  <TableCell>Itinerary</TableCell>
                  {showMap && <TableCell>Map</TableCell>}
                  <TableCell>Cabin</TableCell>
                  <TableCell>Program</TableCell>
                  <TableCell align="right">Nights</TableCell>
                  <TableCell align="right">Seats</TableCell>
                  <TableCell align="right">Cost</TableCell>
                  <TableCell>Book with</TableCell>
                </TableRow>
              </TableHead>
              {/* Each trip brings its OWN `tbody` — see PairRow. */}
              {rows.map((p, i) => (
                <PairRow
                  key={pairKey(p, start + i)}
                  p={p}
                  airports={airports}
                  showMap={showMap}
                />
              ))}
            </Table>
          </TableContainer>
          )}
          {result.pairs.length > PAGE_SIZE_OPTIONS[0]! && (
            <TablePagination
              component="div"
              count={result.pairs.length}
              page={current}
              rowsPerPage={pageSize}
              onPageChange={(_, p) => setPage(p)}
              onRowsPerPageChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              rowsPerPageOptions={PAGE_SIZE_OPTIONS}
              labelRowsPerPage={narrow ? "Rows" : "Rows per page:"}
            />
          )}
        </Box>
      )}

      {(result.pairs.length > 0 || result.truncated) && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", px: 2, pb: 2, pt: 1 }}
        >
          {result.truncated
            ? `Showing the ${result.pairs.length} cheapest of ${result.considered} combinations. `
            : ""}
          Totals are two one-way awards added together, not a round-trip fare — award charts price
          the legs separately, and this app only ever stores a one-way cost.
        </Typography>
      )}
    </Box>
  );
}
