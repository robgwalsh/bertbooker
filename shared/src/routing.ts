import { SEATSAERO_MAX_PAGES } from "./providers/seatsaero.js";

/**
 * A tracked route as a SET of city pairs, not one pair.
 *
 * Searching SEA/PDX -> NRT/HND is the cross product of two airport lists. The
 * route expands into a pair list, search plans over those pairs, and coverage
 * and pruning stay strictly per pair.
 *
 * The economics make this far cheaper than it looks. seats.aero's Cached Search
 * takes comma-delimited airports on BOTH sides (verified live 2026-08-10, see
 * docs/SEATS-AERO.md), so the whole cross product is one query no
 * matter how many pairs it contains. Three origins and two destinations is one
 * call per date chunk — not six pairs' worth.
 *
 * Everything here is pure and offline-testable. Nothing in this file knows about
 * D1, the Worker, or fetch.
 */

export interface RoutePair {
  origin: string;
  destination: string;
}

/** A tracked route's airports. */
export interface RouteSpec {
  origins: string[];
  destinations: string[];
}

/**
 * Caps, and why they are small.
 *
 * Not a spend limit — adding pairs costs almost no calls, because the cap is on
 * PAGES, not pairs. The real cost of a wide route is **truncation**: one call
 * returns at most `take` rows, and the measured SFO->NRT 90-day window was
 * already 851 rows for a single pair. Six pairs is several thousand, which runs
 * `SEATSAERO_MAX_PAGES` out and makes the chunk narrow its own coverage claim —
 * a silent hole at the far end of the window rather than a visible error.
 *
 * These also bound the `IN (...)` placeholder count in the ingest baseline read.
 */
export const MAX_ORIGINS = 3;
export const MAX_DESTINATIONS = 3;

/** Uppercase, trim, drop blanks, dedupe, and sort.
 *
 *  Sorting is not cosmetic: `seatsAeroTaskKey` is built from these lists, and
 *  `search_tasks` is unique on `(run_id, source, task_key)`. Without a stable
 *  order the same route searched twice would produce two different keys for the
 *  same work. */
export function normalizeAirports(codes: readonly string[] | null | undefined): string[] {
  return [...new Set((codes ?? []).map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean))].sort();
}

export class RouteSpecError extends Error {}

/** Validate and normalize. **Throws rather than truncating** — silently dropping
 *  the third origin would search less than the route says it searches, and the
 *  coverage claim would then be about airports nobody asked for. */
export function normalizeSpec(spec: RouteSpec): Required<RouteSpec> {
  const origins = normalizeAirports(spec.origins);
  const destinations = normalizeAirports(spec.destinations);

  if (origins.length === 0) throw new RouteSpecError("a route needs at least one origin");
  if (destinations.length === 0) throw new RouteSpecError("a route needs at least one destination");
  if (origins.length > MAX_ORIGINS) throw new RouteSpecError(`at most ${MAX_ORIGINS} origins`);
  if (destinations.length > MAX_DESTINATIONS) {
    throw new RouteSpecError(`at most ${MAX_DESTINATIONS} destinations`);
  }
  return { origins, destinations };
}

/**
 * Every city pair one search touches: the cross product, minus self-pairs.
 *
 * These are what the COVERAGE CLAIM is made of — including the ones that come
 * back with nothing. "seats.aero answered a query covering PDX->HND and returned
 * no rows for it" is a real `empty`, and claiming it is what lets a vanished find
 * eventually be pruned.
 */
export function routePairs(spec: RouteSpec): RoutePair[] {
  const { origins, destinations } = normalizeSpec(spec);
  return pairsOf(origins, destinations);
}

/** The cross product itself, over sets that have ALREADY been validated. Split
 *  out because a round-trip spec legitimately exceeds MAX_ORIGINS once both
 *  sides are unioned, and re-checking a cap the user never violated would
 *  reject a route the form was right to accept. */
function pairsOf(origins: readonly string[], destinations: readonly string[]): RoutePair[] {
  const out: RoutePair[] = [];
  for (const origin of origins) {
    for (const destination of destinations) {
      if (origin === destination) continue;
      out.push({ origin, destination });
    }
  }
  return out;
}

/**
 * The spec a ROUND-TRIP route actually searches: every airport on BOTH sides.
 *
 * This is the whole implementation of round-trip gathering, and it is nearly
 * free. seats.aero takes comma-delimited airports, so one call with
 * `origin_airport=HND,SEA&destination_airport=HND,SEA` returns SEA->HND *and*
 * HND->SEA — the self-pairs are dropped by `pairsOf` and cost nothing. A
 * round-trip search therefore plans the same number of chunks, and the same
 * number of calls, as the one-way search it replaces.
 *
 * The user's own sets are still validated at MAX_ORIGINS/MAX_DESTINATIONS; the
 * union that comes out the other side may hold up to twice that, which is
 * deliberate and is why `pairsOf` exists.
 *
 * What it does cost is ROWS: roughly twice as many per chunk, so a busy route is
 * likelier to paginate out at SEATSAERO_MAX_PAGES. That narrows the coverage
 * claim honestly (see `runSeatsAeroChunk`), it does not corrupt anything.
 */
export function roundTripSpec(spec: RouteSpec): Required<RouteSpec> {
  const { origins, destinations } = normalizeSpec(spec);
  const both = normalizeAirports([...origins, ...destinations]);
  return { origins: both, destinations: both };
}

/** The spec to search, given whether the route is round trip. One place, so the
 *  planner, the coverage claim and the call estimate cannot disagree. */
export function searchSpec(spec: RouteSpec, roundTrip = false): Required<RouteSpec> {
  return roundTrip ? roundTripSpec(spec) : normalizeSpec(spec);
}

export interface RoutePlan extends Required<RouteSpec> {
  /** What the coverage claim is made of. For a round trip this holds BOTH
   *  directions, which is what lets one task claim both. */
  pairs: RoutePair[];
}

/**
 * What one search will ask for: the airports to send, and every pair that
 * answers to. Resolved once so the query, the coverage claim and the estimate
 * cannot drift apart.
 *
 * Throws `RouteSpecError` on a spec the user should not have been allowed to
 * save — callers turn that into a 400, never an empty result.
 */
export function planRoute(spec: RouteSpec, roundTrip = false): RoutePlan {
  const { origins, destinations } = searchSpec(spec, roundTrip);
  return { origins, destinations, pairs: pairsOf(origins, destinations) };
}

/** Every city pair a search touches, round trip included. */
export function searchPairs(spec: RouteSpec, roundTrip = false): RoutePair[] {
  return planRoute(spec, roundTrip).pairs;
}

export interface CallEstimate {
  pairs: number;
  /** One call per date chunk — what a search costs when every chunk fits in a
   *  single page. */
  floor: number;
  /** Every chunk paginating to `SEATSAERO_MAX_PAGES`. Reachable on a wide route
   *  over a long window, and the point at which coverage starts narrowing. */
  ceiling: number;
}

/**
 * What pressing Search will spend, against 1000 per UTC day. Pure.
 *
 * Quoted as a RANGE because the true number depends on how many rows the window
 * holds, which is the thing a search finds out. The UI shows both ends rather
 * than a single figure that would be wrong in one direction or the other.
 */
export function estimateSearchCalls(
  spec: RouteSpec,
  chunks: number,
  roundTrip = false,
): CallEstimate {
  return {
    // Round trip raises the pair count and leaves floor/ceiling alone, which is
    // the honest shape of it: both directions ride in the same call.
    pairs: searchPairs(spec, roundTrip).length,
    floor: chunks,
    ceiling: chunks * SEATSAERO_MAX_PAGES,
  };
}
