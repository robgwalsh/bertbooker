// AWARD AVAILABILITY — the normalized shape every source must produce and every
// consumer reads. Provider-agnostic on purpose: nothing here knows what
// seats.aero's payload looks like.
//
// `Cabin`, `Segment`, `Currency` and `Alliance` are DECLARED in
// `shared/src/wire/domain.ts` and re-exported here — the SPA reads all four, and
// the wire contract is where the shared half of this vocabulary lives. That is
// the rule for this whole directory: **a model here is Worker-only. If the SPA
// renders it, it is a wire type and it lives in `shared/src/wire/`.** Which is
// why there is no `airport.ts` — `AirportInfo`, `AirportName` and `AirportGeo`
// are all rendered, so all three are wire types.
//
// `routeKey` is here rather than in a util because it is this shape's identity,
// not a string helper: it names the slot a find occupies.

import type { Cabin, Currency, Segment } from "../../../shared/src/wire/domain.js";

export type { Alliance, Cabin, Currency, Segment } from "../../../shared/src/wire/domain.js";

/** The four cabins in ascending value order — useful for "best cabin" logic. */
export const CABIN_ORDER: readonly Cabin[] = ["economy", "premium", "business", "first"];

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
