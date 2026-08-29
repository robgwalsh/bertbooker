import type { Find } from "../../api";
import type { RoundTripPair } from "../../lib/roundtrip";
import { CABIN_OPTIONS } from "./constants";

// Column sorting for the two results tables — `FindsTable` (one-way finds) and
// `RoundTripTable` (paired trips).
//
// Pure and DOM-free (type-only imports on the row shapes), like `findKey.ts`
// beside it, so the `*.test.ts` glob can reach it.
//
// One module for both tables for the reason the two tables share a column order
// and a date width: they are meant to read alike, and a column that sorts one
// way here and another way there is exactly how that stops being true. The
// tables differ only in what a column reads off their row, which is the pair of
// `Record`s below.

export type SortDirection = "asc" | "desc";

/** The one-way table's sortable columns. `Itinerary`, `Map` and `Book with`
 *  are absent on purpose: the first two are pictures of a routing and the third
 *  is a set of cards, and none of the three holds a value two rows can be
 *  ordered by. */
export type FindSortKey = "date" | "cabin" | "program" | "seats" | "cost";

/** The round-trip table's, which is the same list plus the column it has and
 *  the one-way table does not. */
export type TripSortKey = FindSortKey | "nights";

export interface SortState<K extends string> {
  key: K;
  dir: SortDirection;
}

/** Date ascending — soonest first, which is the order somebody planning a trip
 *  reads a window in. Both tables start here. */
export const DEFAULT_SORT = { key: "date", dir: "asc" } as const;

/**
 * What one header click does.
 *
 * A new column sorts ascending; the active column flips. Two states rather than
 * three: there is no "unsorted" to return to, because a table with no order is
 * not a reading either of these can offer — the rows arrive cheapest-first from
 * `pairRoundTrips` or in whatever order the query produced, and neither is
 * something to hand back to somebody who has started sorting.
 */
export function toggleSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key !== key) return { key, dir: "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** Cabin sorts up the LADDER — economy, premium, business, first — not
 *  alphabetically, which would read business, economy, first, premium and order
 *  nothing. `CABIN_OPTIONS` is that ladder and is already in this order. An
 *  unknown cabin sorts after every known one rather than silently at the top. */
const cabinRank = (cabin: string): number => {
  const i = CABIN_OPTIONS.indexOf(cabin);
  return i < 0 ? CABIN_OPTIONS.length : i;
};

type Cell = number | string;

const compare = (a: Cell, b: Cell): number =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

/** Each column's value on a one-way find. `cost` reads `miles_cost` because
 *  that is the figure the Cost cell leads with — the fees and the nonstop
 *  premium under it are other numbers, and ranking a row by one of those would
 *  sort the column by a figure it is not headed with. */
const findCell: Record<FindSortKey, (f: Find) => Cell> = {
  date: (f) => f.flight_date,
  cabin: (f) => cabinRank(f.cabin),
  program: (f) => f.program,
  seats: (f) => f.seats_available,
  cost: (f) => f.miles_cost,
};

/** The same columns on a trip. `program` is per LEG in that table, so a trip is
 *  ordered by its outbound's program and then its return's — the pair of them
 *  is what the column shows. `cost` is the pair's total, which is the figure its
 *  cell leads with. */
const tripCell: Record<TripSortKey, (p: RoundTripPair) => Cell> = {
  date: (p) => p.outbound.flight_date,
  cabin: (p) => cabinRank(p.cabin),
  program: (p) => `${p.outbound.program}|${p.inbound.program}`,
  nights: (p) => p.nights,
  seats: (p) => p.seats,
  cost: (p) => p.totalMiles,
};

/**
 * Sort a copy, never in place — the input is React state owned by a caller
 * upstream.
 *
 * Ties break on the row's date, ASCENDING whichever way the column is pointing:
 * a descending Cost column should still read soonest-first inside each price,
 * because the second key is there to make the list scannable rather than to
 * reverse with the first.
 */
function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K>,
  cell: Record<K, (row: T) => Cell>,
  tieBreak: (row: T) => string,
): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = cell[sort.key];
  return [...rows].sort((a, b) => {
    const primary = compare(value(a), value(b));
    return primary !== 0 ? primary * sign : compare(tieBreak(a), tieBreak(b));
  });
}

export const sortFinds = (finds: Find[], sort: SortState<FindSortKey>): Find[] =>
  sortRows(finds, sort, findCell, (f) => f.flight_date);

/** Both dates in the tie-breaker, so trips sharing a departure read in return
 *  order. Fixed-width ISO dates, so one string compare is the same answer as
 *  comparing the two fields in turn. */
export const sortPairs = (
  pairs: RoundTripPair[],
  sort: SortState<TripSortKey>,
): RoundTripPair[] =>
  sortRows(pairs, sort, tripCell, (p) => `${p.outbound.flight_date}|${p.inbound.flight_date}`);
