// Normalized domain model for award availability.
// Every data source (an aggregator, an airline's own site, seats.aero) must
// produce `AvailabilityResult`s, and every consumer (D1 snapshots, the API, the
// SPA) reads from this shape. Keep this file provider-agnostic.

export type Cabin = "economy" | "premium" | "business" | "first";

/** The four cabins in ascending value order — useful for "best cabin" logic. */
export const CABIN_ORDER: readonly Cabin[] = ["economy", "premium", "business", "first"];

export type ProgramKind = "airline" | "hotel";

/** What a search is looking for. Distinct from ProgramKind: a "flight" search
 *  spans airline programs, a "hotel" search spans hotel programs. */
export type SearchKind = "flight" | "hotel";

export type Alliance = "star" | "oneworld" | "skyteam" | null;

/** A point currency the couple holds and can transfer/redeem from. */
export type Currency =
  | "chase_ur"
  | "capital_one"
  | "bilt"
  | "citi_ty"
  | "direct"; // miles/points held directly in a loyalty program

/** One flown segment within an award itinerary. */
export interface Segment {
  from: string; // IATA
  to: string; // IATA
  carrier: string; // marketing carrier IATA, e.g. "LH"
  flightNumber?: string;
  aircraft?: string;
  /** Booking class letter, e.g. "O" or "T". Which award bucket the seat came out
   *  of, which is the thing you quote to an agent when a website disagrees. */
  fareClass?: string;
  /** ISO local. Absent is a real answer, and a common one: a trip embedded in a
   *  search response carries only the whole trip's endpoints, so its middle legs
   *  genuinely have no times. Never interpolate them from a total duration. */
  departsAt?: string;
  arrivesAt?: string;
  cabin?: Cabin;
}

/** A normalized search request, independent of any provider's query format. */
export interface SearchParams {
  origin: string; // IATA (airport or hotel-city code)
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
  kind: SearchKind;
  hotelId?: string; // when kind === "hotel"
}

/** One bookable award result for a single date/program/cabin. Mirrors a row
 *  in the `availability_snapshots` D1 table. */
export interface AvailabilityResult {
  origin: string;
  destination: string;
  flightDate: string; // ISO date
  program: string; // programs.code
  cabin: Cabin;
  seatsAvailable: number;
  milesCost: number;
  cashFeesCents: number;
  feesCurrency: string; // ISO 4217, e.g. "USD"
  /** What this same itinerary costs as a CASH fare, per passenger, when the
   *  source can see one. Deliberately NOT `cashFeesCents` — that is the residual
   *  tax owed on top of an award redemption. This is the whole ticket price, and
   *  it is what converts into card-portal points at a fixed cents-per-point rate
   *  (see `pointsForCash` in data/programs.ts).
   *
   *  `undefined` means "we don't know" — which is NOT the same as 0. Sources
   *  that only see award inventory leave it unset. */
  cashPriceCents?: number;
  /** ISO 4217 for `cashPriceCents`. Only meaningful when that is set. */
  cashPriceCurrency?: string;
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
  /** Provider id that produced this result, e.g. "freetool:pointsyeah". */
  source: string;
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
