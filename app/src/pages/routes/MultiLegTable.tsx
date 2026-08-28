import { useState } from "react";
import {
  Box,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { AirportName, Find } from "../../api";
import type { Journey, JourneyResult } from "../../lib/multiLeg";
import { FindProgram, JourneyTotalCost } from "./findCells";
import { journeyKey } from "./findKey";
import { findStops, ItineraryCard } from "./Itinerary";
import { RouteMapFill, ROUTE_MAP_CELL_WIDTH, toRouteStops } from "./RouteMap";
import { useAirportNames } from "../../hooks/useAirportNames";
import { BookableCurrencies, CabinChip } from "../../components/brand";
import { DATE_CELL_WIDTH } from "../../lib/layout";
import { dayLabel, formatDuration } from "../../lib/format";
import { useIsPhone } from "../../hooks/useBreakpoints";

// Getting there in two stored legs, when the pair itself is in no program's
// market and comes back empty from every search forever.
//
// Rendered UNDER the flat finds table, never instead of it: a journey is a
// weaker answer than a direct find and must not displace one. On a route with
// `via` hubs the direct table is usually empty and these are the only results
// there will ever be, which is why there is no heading above them — they are the
// answer, not an aside.
//
// It gathers nothing and spends nothing. The legs are ordinary finds the route's
// own search already stored (its second query per date range), or ones some
// other route stored; the work here is only the join (`lib/multiLeg.ts`).
//
// **Three claims here are ours, not the data's**, and the pane says all three:
// the total is an addition we did, the connection is unprotected, and the ground
// time is unknown unless both legs happen to be enriched. The amber register is
// spent on the sharpest of them — a journey whose legs are in different programs
// is two tickets in two currencies that can never become one booking.

/** Rows carry two itineraries, as the round-trip table's do. */
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/** Per-leg cells sit at the top of their row; straddling ones centre on the
 *  journey. The same pair of values both other tables use. */
const LEG_CELL = { verticalAlign: "top", pt: 2 } as const;
const SPAN_CELL = { verticalAlign: "middle" } as const;

/** Pinned to the constant the other two tables use, so all three read alike. */
const DATE_CELL = {
  whiteSpace: "nowrap",
  width: DATE_CELL_WIDTH,
  minWidth: DATE_CELL_WIDTH,
  maxWidth: DATE_CELL_WIDTH,
} as const;

export interface MultiLegTableProps {
  result: JourneyResult;
  /** Draw the Map column. **Defaults on**, moving with the other two tables —
   *  the three share a column order, and a column optional in one and fixed in
   *  another is how they stop reading alike. */
  showMap?: boolean;
}

export function MultiLegTable({ result, showMap: showMapProp }: MultiLegTableProps) {
  const narrow = useIsPhone();
  const showMap = !narrow && showMapProp !== false;

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(result.journeys.length / pageSize));
  const current = Math.min(page, pages - 1);
  const start = current * pageSize;
  const rows = result.journeys.slice(start, start + pageSize);

  // Scoped to the visible page, exactly as the other tables do it: one lookup
  // per table rather than one per row, and none at all without the map.
  const airports = useAirportNames(
    showMap ? rows.flatMap((j) => j.legs.flatMap((l) => findStops(l.find))) : [],
  );

  if (!result.journeys.length) return null;

  return (
    <Box>
      {/* No heading. These ARE the route's results — for a pair nobody sells as
          one trip they are the only ones there will ever be — so announcing them
          as a subsection framed them as an aside to an empty table above. What
          they are is legible from the rows themselves (Leg 1 / Leg 2) and stated
          once, honestly, in the caveat under the table. */}
      {narrow ? (
        <Stack divider={<Divider />}>
          {rows.map((j, i) => (
            <JourneyCard key={journeyKey(j, start + i)} j={j} />
          ))}
        </Stack>
      ) : (
        <TableContainer>
          <Table size="small">
            {/* The finds table's columns, in the finds table's order, so the
                three tables read alike. `Cabin` is the one that moved: per leg
                here rather than straddling the journey, because a journey's legs
                may legitimately differ in it — economy to the hub under a
                business long-haul is the ordinary award shape. */}
            <TableHead>
              <TableRow>
                <TableCell sx={DATE_CELL}>Date</TableCell>
                <TableCell>Itinerary</TableCell>
                {showMap && <TableCell>Map</TableCell>}
                <TableCell>Cabin</TableCell>
                <TableCell>Program</TableCell>
                <TableCell align="right">Seats</TableCell>
                <TableCell align="right">Cost</TableCell>
                <TableCell>Book with</TableCell>
              </TableRow>
            </TableHead>
            {rows.map((j, i) => (
              <JourneyRows
                key={journeyKey(j, start + i)}
                j={j}
                airports={airports}
                showMap={showMap}
              />
            ))}
          </Table>
        </TableContainer>
      )}

      {result.journeys.length > PAGE_SIZE_OPTIONS[0]! && (
        <TablePagination
          component="div"
          count={result.journeys.length}
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

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", px: 2, pb: 2, pt: 1 }}
      >
        {result.truncated
          ? `Showing the ${result.journeys.length} cheapest of ${result.considered} combinations. `
          : ""}
        Each leg is a separate one-way award, booked separately — the totals are sums, not through
        fares, and a missed connection is nobody&apos;s responsibility but yours. Ground time is only
        known once both legs have been enriched.
      </Typography>
    </Box>
  );
}

/**
 * One journey, as one table row per leg inside its own `tbody`.
 *
 * `RoundTripTable`'s two-row shape generalised to N: what is true of the JOURNEY
 * straddles every row with `rowSpan={legs.length}` — the map (it is one path),
 * the stop count, the seats, the total — and what is per leg stays per leg.
 * **`Program`, `Cabin` and `Book with` are all per leg**, and the first two are
 * the change from the round-trip table: pairing there requires one cabin and
 * this deliberately does not, because economy to the hub under a business
 * long-haul is the ordinary award shape.
 *
 * A `tbody` per journey is what makes it one hover target, lets the divider fall
 * between journeys rather than inside one, and gives the amber rule something to
 * run down.
 */
function JourneyRows({
  j,
  airports,
  showMap,
}: {
  j: Journey;
  airports: Map<string, AirportName>;
  showMap: boolean;
}) {
  // ONE path through every stop of every leg, not one line per leg: a journey is
  // a single continuous routing. (`isSamePath` and the second colour belong to
  // the round-trip table, where the question is whether the return retraces the
  // outbound — a reversal test that means nothing here.)
  const stops = toRouteStops(
    j.legs.flatMap((l, i) => (i === 0 ? findStops(l.find) : findStops(l.find).slice(1))),
    airports,
  );

  return (
    <TableBody
      sx={{
        "&:hover td": { bgcolor: (t) => t.palette.action.hover },
        // The divider belongs BETWEEN journeys. Only the cells that stop before
        // the last row, though — a straddling cell's bottom edge already IS the
        // journey's, and clearing it too breaks the rule into segments.
        "& tr:not(:last-of-type) td:not([rowspan])": { borderBottom: "none" },
      }}
    >
      {j.legs.map((leg, i) => {
        const f = leg.find;
        const firstRow = i === 0;
        return (
          <TableRow key={`${f.origin}${f.destination}${f.flight_date}${f.program}`}>
            <TableCell
              sx={{
                ...LEG_CELL,
                ...DATE_CELL,
                // The risk, drawn down the whole journey rather than tucked into
                // one cell — two programs is two tickets, and that is a property
                // of the journey. Set on the cell itself rather than through a
                // descendant selector on the tbody, which is the sort of rule
                // that stops matching the moment a column is added.
                ...(j.mixed
                  ? { borderLeft: (t) => `3px solid ${t.palette.warning.main}` }
                  : {}),
              }}
            >
              {/* The leg's number, then the date exactly as the finds table sets
                  it. With the legs stacked as rows there is otherwise nothing
                  saying which one comes first.

                  The connection rides here rather than in a Stops column of its
                  own: for a two-leg journey that column is the constant 1, and
                  the ground time is a fact about THIS leg's start. It also buys
                  back the width that pushed Cost off the pane. */}
              <Tooltip title={firstRow ? "" : connectionTitle(j)}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  // The cell is `nowrap` so a date never breaks; this caption is
                  // the one thing in it long enough to need to.
                  sx={{ display: "block", whiteSpace: "normal" }}
                >
                  Leg {i + 1}
                  {firstRow ? "" : ` · ${gapLabel(leg.gapMinutes, j.connectDays)}`}
                </Typography>
              </Tooltip>
              {dayLabel(f.flight_date)}
            </TableCell>
            <TableCell sx={{ minWidth: 340 }}>
              <ItineraryCard f={f} />
            </TableCell>

            {firstRow && showMap && (
              <TableCell
                rowSpan={j.legs.length}
                sx={{
                  position: "relative",
                  p: 0,
                  width: ROUTE_MAP_CELL_WIDTH,
                  minWidth: ROUTE_MAP_CELL_WIDTH,
                }}
              >
                <RouteMapFill paths={[{ stops }]} />
              </TableCell>
            )}

            <TableCell sx={LEG_CELL}>
              <CabinChip cabin={f.cabin} />
            </TableCell>
            <TableCell sx={LEG_CELL}>
              <FindProgram f={f} />
            </TableCell>

            {firstRow && (
              <>
                <TableCell rowSpan={j.legs.length} align="right" sx={SPAN_CELL}>
                  <Tooltip title={seatsTitle(j)}>
                    <span>{j.seats}</span>
                  </Tooltip>
                </TableCell>
                <TableCell
                  rowSpan={j.legs.length}
                  align="right"
                  sx={{ ...SPAN_CELL, whiteSpace: "nowrap" }}
                >
                  <JourneyTotalCost j={j} />
                  {j.mixed && (
                    <Box sx={{ mt: 0.5 }}>
                      <TwoAwardsChip />
                    </Box>
                  )}
                </TableCell>
              </>
            )}

            <TableCell sx={LEG_CELL}>
              <BookableCurrencies json={f.transfer_currencies} />
            </TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  );
}

/**
 * One journey on a phone.
 *
 * The `rowSpan` structure converts the way `PairCard`'s does: the straddling
 * cells are the journey-level facts and become the heading, the per-leg cells
 * become blocks under it. The amber rule becomes the card's own left border, so
 * the risk survives the breakpoint — losing it here would be losing the whole
 * point of drawing it.
 *
 * The map does not come along, as in every other card layout: it is the one cell
 * that is a fixed-width picture rather than a fact.
 */
function JourneyCard({ j }: { j: Journey }) {
  return (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        ...(j.mixed
          ? { borderLeft: (t) => `3px solid ${t.palette.warning.main}` }
          : {}),
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 1 }}
      >
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="body2" color="text.secondary">
            {j.legs.length - 1} stop{j.legs.length - 1 === 1 ? "" : "s"} · via {j.via.join(", ")}
          </Typography>
          <Tooltip title={seatsTitle(j)}>
            <Typography variant="body2" color="text.secondary" sx={{ cursor: "help" }}>
              {j.seats} seat{j.seats === 1 ? "" : "s"}
            </Typography>
          </Tooltip>
          {j.mixed && <TwoAwardsChip />}
        </Stack>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <JourneyTotalCost j={j} />
        </Box>
      </Stack>

      {j.legs.map((leg, i) => (
        <JourneyLegBlock
          key={`${leg.find.origin}${leg.find.destination}${leg.find.flight_date}`}
          leg={leg}
          index={i}
          connectDays={j.connectDays}
        />
      ))}
    </Box>
  );
}

/** One leg of a journey card. Modelled on `TripLeg`, with the cabin moved in
 *  beside the program because it is per leg here. */
function JourneyLegBlock({
  leg,
  index,
  connectDays,
}: {
  leg: Journey["legs"][number];
  index: number;
  connectDays: number;
}) {
  const f: Find = leg.find;
  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ width: 34, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          Leg {index + 1}
        </Typography>
        <Typography variant="body2">{dayLabel(f.flight_date)}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {f.program}
        </Typography>
      </Stack>
      <Box sx={{ pl: "42px" }}>
        {index > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {gapLabel(leg.gapMinutes, connectDays)}
          </Typography>
        )}
        <ItineraryCard f={f} />
        <Stack direction="row" spacing={1} sx={{ mt: 0.5, alignItems: "center", flexWrap: "wrap" }}>
          <CabinChip cabin={f.cabin} />
          <BookableCurrencies json={f.transfer_currencies} />
        </Stack>
      </Box>
    </Box>
  );
}

/**
 * The sharpest claim on the pane, in the chip recipe every verdict here uses.
 * Two programs cannot become one ticket, in any program, ever.
 *
 * Labelled short on purpose. It sits under the total in the Cost column, and the
 * spelled-out version measured 156px — enough on its own to push `Book with` off
 * the pane. The programs are already named per leg two columns to the left, so
 * what the chip has to add is that they are separate BOOKINGS; the rest is the
 * tooltip's job.
 */
function TwoAwardsChip() {
  return (
    <Tooltip title="Each leg is in a different program: two separate award bookings, paid from two different currencies. No airline can put them on one ticket, so a missed connection is not rebooked and not refunded.">
      <Chip
        size="small"
        label="2 awards"
        sx={{
          cursor: "help",
          bgcolor: (t) => alpha(t.palette.warning.main, 0.14),
          color: "warning.main",
          border: (t) => `1px solid ${alpha(t.palette.warning.main, 0.35)}`,
        }}
      />
    </Tooltip>
  );
}

const seatsTitle = (j: Journey): string =>
  `The lowest leg's (${j.legs.map((l) => l.find.seats_available).join(", ")}) — a journey needs seats on every leg.`;

/** What is known about the gap before a leg. An unknown one says so: a summary
 *  row carries no times at all, and printing "0m" would invent a connection. */
const gapLabel = (gapMinutes: number | null, connectDays: number): string =>
  gapMinutes != null
    ? `${formatDuration(gapMinutes)} on the ground`
    : connectDays === 0
      ? "same day · gap unknown"
      : `+${connectDays}d · gap unknown`;

/** Why the gap is the part to check. Separate bookings mean nobody is holding
 *  the second leg for you, whether or not the first one is late. */
function connectionTitle(j: Journey): string {
  const known = j.legs.slice(1).every((l) => l.gapMinutes != null);
  const days = j.connectDays === 0 ? "the same day" : `${j.connectDays} day later`;
  return known
    ? `Connects ${days}. Separate bookings, so nobody is holding this leg if the first one is late — allow for it.`
    : `Connects ${days}, and the ground time is unknown: these legs carry no times until they are enriched. Separate bookings either way.`;
}
