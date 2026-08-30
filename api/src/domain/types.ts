// Normalized domain model for award availability.
// Every data source (an aggregator, an airline's own site, seats.aero) must
// produce `AvailabilityResult`s, and every consumer (D1 snapshots, the API, the
// SPA) reads from this shape. Keep this file provider-agnostic.
//
// `Cabin`, `Segment`, `Currency` and `Alliance` are DECLARED in
// `./wire/domain.ts` and re-exported here — the SPA reads all four, and the wire
// contract is where the shared half of this vocabulary lives. Importing them
// from here goes on working exactly as before; see the banner in that file for
// why the direction is that way round and not this one.

import type { Cabin, Currency, Segment } from "../../../shared/src/wire/domain.js";

export type { Alliance, Cabin, Currency, Segment } from "../../../shared/src/wire/domain.js";

/** The four cabins in ascending value order — useful for "best cabin" logic. */
export const CABIN_ORDER: readonly Cabin[] = ["economy", "premium", "business", "first"];

/** A program is an airline's or a hotel's. Nothing SEARCHES a hotel program —
 *  the Library page is what renders them. */
export type ProgramKind = "airline" | "hotel";

/** A normalized search request, independent of any provider's query format. */
export interface SearchParams {
  origin: string; // IATA
  destination: string; // IATA
  dateStart: string; // ISO date (YYYY-MM-DD)
  dateEnd: string; // ISO date (inclusive)
  /** Restrict to these cabins; undefined/empty = any cabin. */
  cabins?: Cabin[];
  /** Restrict to these program codes; undefined = all supported. */
  programs?: string[];
  /** Restrict to space bookable with these transfer currencies (e.g.
   *  ["chase_ur","bilt"]); undefined/empty = any the couple can book. */
  currencies?: string[];
  minSeats: number; // couple => 2
}

/** One bookable award result for a single date/program/cabin. Mirrors a row
 *  in the `finds` D1 table. */
export interface AvailabilityResult {
  origin: string;
  destination: string;
  flightDate: string; // ISO date
  program: string; // programs.code
  cabin: Cabin;
  seatsAvailable: number;
  milesCost: number;
  /** The residual tax owed on top of an award redemption — not a ticket price. */
  cashFeesCents: number;
  feesCurrency: string; // ISO 4217, e.g. "USD"
  isDirect: boolean;
  segments: Segment[];
  /** Number of stops (0 = nonstop), or `undefined` for **genuinely unknown**.
   *
   *  Redundant with `segments.length - 1` once segments are populated, but
   *  carried explicitly because a summary-only result has one synthetic leg and
   *  would otherwise read as nonstop. `undefined` is a real and common answer:
   *  seats.aero's Cached Search, asked without `include_trips`, says a
   *  connecting award exists without ever saying how many stops it has. It is
   *  stored in `stop_count`, which is nullable precisely so it can express
   *  that. */
  stops?: number;
  /** Every carrier appearing on any itinerary for this (route, date, program,
   *  cabin) — not just the one on `segments`. */
  airlines?: string[];
  /** The subset of `airlines` that flies it NONSTOP. Empty when none does. */
  directAirlines?: string[];
  /** What the nonstop costs, when a nonstop exists and is priced differently
   *  from `milesCost` (which quotes the cheapest itinerary of any shape). */
  directMilesCost?: number;
  /** Total itinerary duration in minutes, gate to gate incl. layovers. */
  durationMinutes?: number;
  /** Deep link to book this award on the airline/loyalty program's own site,
   *  when the source provides one. Falls back to a flight search in the UI. */
  bookingUrl?: string;
  /** The SOURCE's own id for the availability record this came out of — the
   *  handle a later per-itinerary detail fetch needs. seats.aero's Availability
   *  `ID`; unset for sources that expose no such id.
   *
   *  Deliberately not unique per result: one seats.aero id covers all four
   *  cabins of a (route, date, program), so four `AvailabilityResult`s share
   *  one, and one detail call enriches all of them. */
  sourceRecordId?: string;
  /** How much of the itinerary this result actually describes.
   *
   *  `"summary"` means `segments` is a single synthetic leg with no flight
   *  number — the source said "there is space at this price" and nothing about
   *  which aeroplane. `"itinerary"` means the legs are real. Absent means
   *  `"itinerary"`, which is right for every source that isn't seats.aero
   *  Cached Search. */
  detailLevel?: "summary" | "itinerary";
  /** When the *provider's* data was current (unix ms), not when we fetched. */
  sourceFetchedAt: number;
  /** Which of the couple's currencies can book this (from the source's transfer
   *  data). Empty/undefined when unknown. Powers "bookable with my points". */
  bookableWith?: Currency[];
}

/** Canonical key for a route+date, used for caching and snapshot grouping. */
export function routeKey(origin: string, destination: string, flightDate: string): string {
  return `${origin}-${destination}-${flightDate}`;
}
