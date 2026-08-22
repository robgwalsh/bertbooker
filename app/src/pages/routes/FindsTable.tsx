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
  useTheme,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { type AirportName, type Find } from "../../api";
import { FindCost } from "./findCells";
import { findKey } from "./findKey";
import { findStops, ItineraryCard } from "./Itinerary";
import { RouteMapFill, ROUTE_MAP_CELL_WIDTH, toRouteStops } from "./RouteMap";
import { useAirportNames } from "../../hooks/useAirportNames";
import { BookableCurrencies, CabinChip } from "../../components/brand";
import { DATE_CELL_WIDTH } from "../../lib/layout";
import { dayLabel } from "../../lib/format";
import { useIsPhone } from "../../hooks/useBreakpoints";

// The one table that renders stored award finds. **One caller:** the Routes
// page (a route's current finds, route implied by its heading).
//
// Extracted from the Routes page rather than duplicated: these cells encode real
// decisions — cash fares shown beside miles and never ranked against them, a
// booking link that falls back to Google Flights — and a second copy would drift
// away from them quietly.
//
// The itinerary itself is drawn by `ItineraryCard`: the legs, their times and
// their layovers are on the row, not behind a chevron.

/**
 * Optional columns.
 *
 * `showMap` defaults **on** while an added column would default off, and the
 * asymmetry is the rule to keep: a removal's absent value has to mean "as
 * before", and an addition's has to mean the opposite.
 */
export interface FindsTableOptions {
  /**
   * Draw the routing as geography beside each itinerary. **Defaults on.**
   *
   * A user preference on the Routes page (`app/src/preferences.ts`), passed in
   * rather than read in here — the separation is what let a second caller hold a
   * different answer, and is what one would need again.
   */
  showMap?: boolean;
  /** Page the rows *here*, in the browser, for callers that hand over the whole
   *  set at once — which is now every caller, since the Routes page's finds
   *  arrive with the `/api/routes` payload. Still off by default: a server-paged
   *  caller and this pager would fight over one table. */
  paginate?: boolean;
}

/** Rows per page when this table pages its own rows. A wide route can hold a
 *  thousand finds, and every one of them draws an itinerary — which is what made
 *  opening a route slow. */
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_OPTIONS = [15, 25, 50, 100, 200];

/** The Date column, pinned. `width` alone is a suggestion under `table-layout:
 *  auto` — it is the pair with `minWidth`/`maxWidth` that actually holds the
 *  column still, which is the point: see `DATE_CELL_WIDTH`. Applied to the head
 *  cell as well as the body cells, since either can be the widest one. */
const DATE_CELL = {
  whiteSpace: "nowrap",
  width: DATE_CELL_WIDTH,
  minWidth: DATE_CELL_WIDTH,
  maxWidth: DATE_CELL_WIDTH,
} as const;

// One find: the itinerary drawn in the wide cell, everything priced or
// attributed in a column beside it. One row, no sub-rows — award pricing is
// quoted once for the whole trip, so there was never anything to put in the
// numeric columns of a per-leg row. The row's two ACTIONS are not a column
// either; they live on the itinerary card, which is what they act on.
function FindRow({
  f,
  stops,
  airports,
  opts,
}: {
  f: Find;
  /** The row's airports in order, resolved by the table so one lookup covers
   *  the whole page. */
  stops: string[];
  airports: Map<string, AirportName>;
  opts: FindsTableOptions;
}) {
  return (
    <TableRow hover>
      {/* The DEPARTURE date, and the only place it appears — the card next to it
          does not restate the arrival date, which is the same day on all but a
          red-eye. What survives there is the `+N` beside the arrival time, which
          is the part this column can't say. */}
      <TableCell sx={{ ...DATE_CELL, verticalAlign: "top", pt: 2 }}>
        {dayLabel(f.flight_date)}
      </TableCell>
      <TableCell sx={{ minWidth: 340 }}>
        <ItineraryCard f={f} />
      </TableCell>
      {/* The same routing as the card beside it, drawn as geography. Fixed
          width, because a map that resized with the table would reframe itself
          on every column change — and `minWidth` as well as `width` so the
          column holds its place while the coordinate lookup is in flight and
          every map in it is still rendering nothing.

          The HEIGHT is whatever the itinerary cell decided: `RouteMapFill`
          positions the widget absolutely and sizes it to what is left, so the
          map can never be what makes this row tall. That is what the cell's
          `position: relative` and `p: 0` are for — see RouteMapFill. */}
      {opts.showMap !== false && (
        <TableCell
          sx={{
            position: "relative",
            p: 0,
            width: ROUTE_MAP_CELL_WIDTH,
            minWidth: ROUTE_MAP_CELL_WIDTH,
          }}
        >
          <RouteMapFill paths={[{ stops: toRouteStops(stops, airports) }]} />
        </TableCell>
      )}
      <TableCell sx={{ verticalAlign: "top", pt: 2 }}>
        <CabinChip cabin={f.cabin} />
      </TableCell>
      <TableCell sx={{ verticalAlign: "top", pt: 2 }}>{f.program}</TableCell>
      <TableCell align="right" sx={{ verticalAlign: "top", pt: 2 }}>
        {f.seats_available}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap", verticalAlign: "top", pt: 2 }}>
        <FindCost f={f} />
      </TableCell>
      <TableCell sx={{ verticalAlign: "top", pt: 2 }}>
        <BookableCurrencies json={f.transfer_currencies} />
      </TableCell>
    </TableRow>
  );
}

/**
 * One find on a phone: the same cells, stacked, in the same reading order.
 *
 * Lives beside `FindRow` on purpose — they are two renderings of one row, and
 * keeping them adjacent is what makes a missing field obvious in review. The
 * bodies they share come from `findCells.tsx`; nothing here formats a number of
 * its own.
 *
 * **The Map is the one column that does not survive.** It is a fixed 232px
 * picture of the routing the itinerary above it already spells out, it is
 * already shaped as an optional removal (`showMap`), and dropping it also drops
 * the `/api/airports/lookup` those coordinates exist for. Every other column is
 * here.
 */
function FindCard({ f, opts }: { f: Find; opts: FindsTableOptions }) {
  return (
    // The card supplies its own horizontal inset because the table it replaces
    // never did — `MuiTableCell`'s padding is what held the rows off the edge,
    // and on the Routes page this list is full-bleed in the editor pane. The
    // rule between cards stays full width, as the rail's rows do.
    <Box sx={{ px: 2, py: 1.5 }}>
      {/* The heading line: where and when, with the cabin as the one chip that
          carries colour. `flexWrap` because a route plus a long date plus a
          cabin is the one line here that can genuinely run out of room. */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: "baseline", flexWrap: "wrap", mb: 0.5 }}
      >
        <Typography variant="body2">{dayLabel(f.flight_date)}</Typography>
        <Box sx={{ ml: "auto" }}>
          <CabinChip cabin={f.cabin} />
        </Box>
      </Stack>

      <ItineraryCard f={f} />

      {/* Program and seats against the price, which is the comparison somebody
          scanning a phone is actually making. `alignItems: flex-start` so the
          price's second and third lines (fees, portal) hang under the first
          rather than centring the whole block against one line of text. */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mt: 0.5 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2">{f.program}</Typography>
          <Typography variant="caption" color="text.secondary">
            {f.seats_available} seat{f.seats_available === 1 ? "" : "s"}
          </Typography>
        </Box>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <FindCost f={f} />
        </Box>
      </Stack>

      <Box sx={{ mt: 0.75 }}>
        <BookableCurrencies json={f.transfer_currencies} />
      </Box>
    </Box>
  );
}

export function FindsTable({
  finds,
  ...opts
}: { finds: Find[] } & FindsTableOptions) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Clamped on read rather than reset in an effect: a search finishing under an
  // open route can shrink the set while you are on the last page, and the honest
  // answer to "page 9 of 3" is page 3, not an empty table for one frame.
  const pageCount = Math.max(1, Math.ceil(finds.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const rows = opts.paginate ? finds.slice(start, start + pageSize) : finds;

  // Cards on a phone, the table everywhere else. Different markup rather than
  // restyled cells — see `useIsPhone`.
  const narrow = useIsPhone();

  // Resolved once for the header; `FindRow` reads the same flag off `opts` for
  // its own cell, and the two have to agree or the column and its heading come
  // apart.
  //
  // Never on a phone, whatever the caller asked for: `FindCard` draws no map, so
  // a `true` here would only buy a coordinate lookup for a column nothing
  // renders.
  const showMap = !narrow && opts.showMap !== false;

  // Each row's airports, derived once here rather than in the row: the maps need
  // one coordinate lookup for the whole page, and `findStops` parses
  // `segments_json`, so doing it per row twice would be twice the parsing.
  //
  // Scoped to the VISIBLE page, not to `finds`: a wide route holds a thousand
  // finds and a lookup for all of them would ask about airports no map on screen
  // is going to draw. Scoped to nothing at all when the column is hidden — these
  // coordinates feed the maps and only the maps, so the request should go with
  // them. The hook is still CALLED unconditionally (it is a hook) and no-ops on
  // an empty list: `enabled: key.length > 0`.
  const stops = rows.map(findStops);
  const airports = useAirportNames(showMap ? stops.flat() : []);

  return (
    <>
      {narrow ? (
        // Rules between cards rather than boxes around them, the same way the
        // table draws its rows: a page of outlined cards on a phone reads as a
        // stack of separate documents, and these are rows of one list.
        <Stack divider={<Divider />}>
          {rows.map((f, i) => (
            <FindCard key={findKey(f, start + i)} f={f} opts={opts} />
          ))}
        </Stack>
      ) : (
      <TableContainer>
        <Table size="small">
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
          <TableBody>
            {rows.map((f, i) => (
              <FindRow
                key={findKey(f, start + i)}
                f={f}
                stops={stops[i]!}
                airports={airports}
                opts={opts}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      )}
      {opts.paginate && finds.length > PAGE_SIZE_OPTIONS[0]! && (
        <TablePagination
          component="div"
          count={finds.length}
          page={current}
          rowsPerPage={pageSize}
          onPageChange={(_, p) => setPage(p)}
          onRowsPerPageChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={PAGE_SIZE_OPTIONS}
          // "Rows per page:" beside a select, a range and two arrows does not fit
          // a phone; the select under it says what it is without the sentence.
          labelRowsPerPage={narrow ? "Rows" : "Rows per page:"}
        />
      )}
    </>
  );
}

// The pure half of this — the tone vocabulary and its theme lookup — moved to
// `lib/statusTone.ts`, so it is reachable by the `*.test.ts` glob that a `.tsx`
// file can never satisfy. Re-exported here because a status palette is what a
// caller of this file would go looking for.
export { TASK_STATUS_TONE, toneColor, type StatusTone } from "../../lib/statusTone";
import { TASK_STATUS_TONE, toneColor } from "../../lib/statusTone";

export function StatusChip({ status, title }: { status: string; title?: string }) {
  const theme = useTheme();
  const color = toneColor(TASK_STATUS_TONE[status] ?? "muted", theme);
  const chip = (
    <Chip
      size="small"
      label={status}
      sx={{
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
        fontWeight: 600,
      }}
    />
  );
  return title ? <Tooltip title={title}>{chip}</Tooltip> : chip;
}
