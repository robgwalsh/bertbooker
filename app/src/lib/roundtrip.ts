import type { Find, TrackedRoute } from "../api";
import { addDaysISO, daysBetween, routeSets } from "./routeShape";

/**
 * Pairing stored one-way finds into round trips.
 *
 * READ-TIME ONLY, and the reason matters. seats.aero indexes one-way
 * availability and quotes a one-way `miles_cost`; no source this app has ever
 * returns a round-trip fare. So nothing here gathers, stores or prices anything
 * — it answers a question the one-way tables cannot: *which combinations of a
 * stored outbound and a stored return are N-M nights apart with space both
 * ways.* Two tracked routes each tell you half of that and leave the date
 * arithmetic to you.
 *
 * The `totalMiles` this produces is an ADDITION WE DID. For nearly every program
 * seats.aero carries a one-way award is exactly half a round trip, so the sum is
 * the true price; but where a program prices round trips on their own chart, the
 * discount lives in the airline's booking engine and is invisible here. Every
 * surface rendering the total has to say so.
 *
 * Pure and dependency-free (no React, no MUI) so the test loads nothing heavy.
 */

/** Bounds on the CUSTOM trip-length slider — a reading control, not a limit on
 *  what can pair. Nobody drags a slider to plan a three-month award trip, and a
 *  span wider than a month is better expressed as "the whole window". */
export const MAX_NIGHTS = 60;
export const MAX_NIGHTS_SPAN = 30;
/** Where the custom slider starts when you switch it on. Not the pane's default
 *  — that is the route's own window, which constrains nothing. */
export const DEFAULT_MIN_NIGHTS = 7;
export const DEFAULT_MAX_NIGHTS = 14;

/**
 * The ceiling on `maxNights`, and what keeps the nights loop finite.
 *
 * Deliberately NOT `MAX_NIGHTS`, which bounds the SLIDER: this is the backstop on
 * whatever reaches `pairRoundTrips`, and 365 is the real ceiling because
 * `effectiveSearchWindow` clamps every search to `today + 365` — no window longer
 * than that was ever gathered, so no pair can span more.
 *
 * It bounds the nights mode only. The whole-window mode names two dates and
 * derives its nights from them, so nothing there is clamped: a 300-day window's
 * one trip is 300 nights and that is the honest answer.
 */
export const MAX_WINDOW_NIGHTS = 365;
const DEFAULT_LIMIT = 200;

/** One pairing of two stored ONE-WAY finds. */
export interface RoundTripPair {
  /** The stored rows, verbatim. snake_case because they are database columns;
   *  the derived fields below are camelCase because they exist in no table. */
  outbound: Find;
  inbound: Find;
  nights: number;
  /** Both legs, by construction. */
  cabin: string;
  /** `outbound.miles_cost + inbound.miles_cost`. A SUM OF TWO ONE-WAYS. */
  totalMiles: number;
  /** Sum of the two legs' award taxes. Same caveat. */
  totalFeesCents: number;
  /** The LOWER of the two legs — a trip needs seats in both directions. */
  seats: number;
}

/**
 * The two questions this pane can ask, and they are genuinely different questions
 * rather than one with a wider default.
 *
 * - `nights` — *"which trips of N–M nights are stored, anywhere in the window?"*
 *   A length, floating across every departure date the route gathered.
 * - `dates` — *"is there a trip that leaves on this day and comes back on that
 *   one?"* Two fixed dates. This is what **Whole window** means: out on
 *   `date_start`, back on `date_end`, and no other pair of dates. A route whose
 *   window IS the trip you are planning asks exactly this, and it is not
 *   expressible as a nights range — `maxNights = windowNights` would also accept
 *   a departure two days late returning two days after the window, which is a
 *   different trip and, on a route whose window is what you can actually travel,
 *   the wrong one.
 */
export type RoundTripOptions = RoundTripNights | RoundTripDates;

export interface RoundTripNights {
  mode: "nights";
  minNights: number;
  maxNights: number;
  /** Cheapest-first; the rest are dropped and `truncated` says so. */
  limit?: number;
}

export interface RoundTripDates {
  mode: "dates";
  /** The outbound's `flight_date`, exactly. */
  departOn: string;
  /** The return's `flight_date`, exactly. */
  returnOn: string;
  limit?: number;
}

export interface RoundTripResult {
  pairs: RoundTripPair[];
  /** Combinations that passed the filter BEFORE `limit` was applied. */
  considered: number;
  truncated: boolean;
  /** Collapsed slots that entered the pairing, per side — the whole direction,
   *  not just the dates that pair. These are what let the caller tell "the return
   *  direction holds nothing at all" apart from "it holds legs, but none that
   *  make this trip" — two empty states whose remedies are opposite, and only one
   *  of which is fixed by changing the question. */
  outboundSlots: number;
  inboundSlots: number;
  /** `dates` mode only: slots sitting on each anchor date itself, which is the
   *  distinction that mode's empty state turns on — *nothing flies out that day*
   *  and *nothing comes back that day* are separate facts, and neither is "no
   *  trip is this long". `null` in `nights` mode, where the question is
   *  meaningless. */
  departDateSlots: number | null;
  returnDateSlots: number | null;
}

// --- picking one leg per slot ----------------------------------------------

/** Stops, with the null case handled honestly. `stop_count` is nullable and
 *  NULL means GENUINELY UNKNOWN — seats.aero's Cached Search reports that a
 *  connecting award exists without saying how many stops it has — so it falls
 *  back to the direct flag and otherwise sorts last rather than inventing a
 *  number. */
function stopsOf(f: Find): number {
  if (f.stop_count != null) return f.stop_count;
  return f.is_direct ? 0 : Number.POSITIVE_INFINITY;
}

/**
 * Cheapest miles wins; ties break on more seats, then fewer stops, then shorter.
 *
 * Deliberately the same ORDER as `betterOffer` in
 * `api/src/domain/collapse.ts`, and deliberately not a call to it: the SPA
 * imports nothing from `shared/`, and its `Collapsible` is the camelCase
 * normalized shape requiring `segments`, which the wire `Find` does not carry
 * (it has `segments_json`). Satisfying that type with `segments: []` would make
 * every leg here look like nine stops. If the ranking in collapse.ts changes,
 * change it here too.
 */
export function betterLeg(a: Find, b: Find): boolean {
  if (a.miles_cost !== b.miles_cost) return a.miles_cost < b.miles_cost;
  if (a.seats_available !== b.seats_available) return a.seats_available > b.seats_available;
  const as = stopsOf(a);
  const bs = stopsOf(b);
  if (as !== bs) return as < bs;
  return (a.duration_minutes ?? Infinity) < (b.duration_minutes ?? Infinity);
}

const slotKey = (f: Find) => `${f.origin}|${f.destination}|${f.flight_date}|${f.cabin}`;

/**
 * One best leg per (origin, destination, flight_date, cabin).
 *
 * The CITY PAIR is part of the key and is never collapsed across: a route
 * watching SEA/PDX -> NRT/HND has nine real pairs, and merging SEA->NRT with
 * PDX->NRT would offer a leg from an airport you are not standing in. Same
 * reason the route is part of the collapse key in ingest.
 *
 * Run on both sides BEFORE pairing, which is what turns an O(out x in) cross
 * product into O(slots x nightsSpan). It also absorbs the duplicate rows that
 * arrive when one find is tagged under two overlapping tracked routes.
 *
 * Collapsing to CHEAPEST rather than most-seats is safe because each route's own
 * `min_seats` was already applied server-side by the dashboard join, so every
 * survivor already clears the floor.
 */
export function collapseLegs(finds: readonly Find[]): Find[] {
  const best = new Map<string, Find>();
  for (const f of finds) {
    const k = slotKey(f);
    const cur = best.get(k);
    if (!cur || betterLeg(f, cur)) best.set(k, f);
  }
  return [...best.values()];
}

// --- the pairing ------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

/**
 * Which combinations of a stored outbound and a stored return make a trip.
 *
 * Pure and total; neither input is mutated. The rules, all fixed:
 *
 *  - **`inbound.origin === outbound.destination`** — you return from where you
 *    landed. Without it a multi-airport route silently invents open jaws whose
 *    ground leg nobody modelled.
 *  - The HOME end is left free: a route listing SEA and PDX lists them because
 *    they are interchangeable, so landing back at either is a real answer.
 *  - Same cabin both legs.
 *  - Programs MAY differ. Out on one and back on another is a trip you can
 *    actually book, and refusing it would hide the ordinary case.
 *
 * `opts.mode` picks which question is being asked — see `RoundTripOptions`. In
 * `nights` mode both bounds are clamped to `[0, MAX_WINDOW_NIGHTS]`, which is the
 * only clamp here; `router.tsx` validates the slider's own range first, so
 * clamping again means a bad call narrows the answer rather than wedging the tab.
 * `dates` mode clamps nothing: it derives its single night count from the two
 * dates, and a return that precedes its own departure simply pairs nothing.
 */
export function pairRoundTrips(
  outbound: readonly Find[],
  inbound: readonly Find[],
  opts: RoundTripOptions,
): RoundTripResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const out = collapseLegs(outbound);
  const back = collapseLegs(inbound);

  // Keyed on the RETURN's departure airport, date and cabin — everything a
  // candidate is required to match. The destination is deliberately absent, so
  // one lookup yields every way home (at most one per home airport).
  const index = new Map<string, Find[]>();
  for (const f of back) {
    const k = `${f.origin}|${f.flight_date}|${f.cabin}`;
    const arr = index.get(k);
    if (arr) arr.push(f);
    else index.set(k, [f]);
  }

  const pairs: RoundTripPair[] = [];
  const add = (o: Find, i: Find, nights: number) =>
    pairs.push({
      outbound: o,
      inbound: i,
      nights,
      cabin: o.cabin,
      totalMiles: o.miles_cost + i.miles_cost,
      totalFeesCents: o.cash_fees_cents + i.cash_fees_cents,
      seats: Math.min(o.seats_available, i.seats_available),
    });

  if (opts.mode === "dates") {
    const nights = daysBetween(opts.departOn, opts.returnOn);
    // A window that ends before it starts is a route to fix, not a trip to
    // report; same-day (0) is a real answer and stays.
    if (Number.isFinite(nights) && nights >= 0) {
      for (const o of out) {
        if (o.flight_date !== opts.departOn) continue;
        const candidates = index.get(`${o.destination}|${opts.returnOn}|${o.cabin}`);
        if (!candidates) continue;
        for (const i of candidates) add(o, i, nights);
      }
    }
  } else {
    const min = clamp(opts.minNights, 0, MAX_WINDOW_NIGHTS);
    const max = clamp(opts.maxNights, min, MAX_WINDOW_NIGHTS);
    for (const o of out) {
      for (let n = min; n <= max; n++) {
        const candidates = index.get(`${o.destination}|${addDaysISO(o.flight_date, n)}|${o.cabin}`);
        if (!candidates) continue;
        for (const i of candidates) add(o, i, n);
      }
    }
  }

  const considered = pairs.length;
  pairs.sort((a, b) => a.totalMiles - b.totalMiles || a.nights - b.nights);
  return {
    pairs: pairs.slice(0, limit),
    considered,
    truncated: considered > limit,
    outboundSlots: out.length,
    inboundSlots: back.length,
    departDateSlots:
      opts.mode === "dates" ? out.filter((f) => f.flight_date === opts.departOn).length : null,
    returnDateSlots:
      opts.mode === "dates" ? back.filter((f) => f.flight_date === opts.returnOn).length : null,
  };
}

// --- splitting one round-trip route's finds by direction --------------------

/**
 * A round-trip route's finds, split into the two directions it gathered.
 *
 * One route holds both, because its search put every airport on both sides of a
 * single seats.aero call (`roundTripSpec`, core `routing.ts`).
 *
 * The split is what makes the route's ORIGINS mean "home": a trip leaves from an
 * origin and comes back to one. Without it, pairing would also offer the mirror
 * trip (fly HND->SEA, return SEA->HND), which is a real itinerary and never the
 * one you meant.
 *
 * A find matching BOTH patterns lands in BOTH lists. That only happens when the
 * user deliberately typed overlapping sets (SEA/HND -> HND/SEA), and for such a
 * route both orientations genuinely are trips. Dropping it from one list instead
 * would silently empty that side and produce no pairs at all.
 */
export function splitDirections(
  route: TrackedRoute,
  finds: readonly Find[],
): { outbound: Find[]; inbound: Find[] } {
  const { origins, destinations } = routeSets(route);
  const outbound: Find[] = [];
  const inbound: Find[] = [];
  for (const f of finds) {
    if (origins.includes(f.origin) && destinations.includes(f.destination)) outbound.push(f);
    if (destinations.includes(f.origin) && origins.includes(f.destination)) inbound.push(f);
  }
  return { outbound, inbound };
}

// --- the route's own window as a trip length --------------------------------

/**
 * How long the whole-window trip is: `date_start` to `date_end` in nights.
 *
 * Derived, never a filter — the pane's default mode names the two dates and this
 * only puts a number on the gap for the copy to quote. Using it as the default
 * *max nights* would be the mistake: a length that happens to equal the
 * window also matches a trip shifted a week later, gathered under the same route
 * and off the dates you can actually travel.
 *
 * Inclusive of both endpoints in the sense that matters: a Mar 1 - Mar 31 route
 * holds legs 30 nights apart, so 30 is the answer, not 31.
 */
export function windowNightsFor(route: TrackedRoute): number {
  const n = daysBetween(route.date_start, route.date_end);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
