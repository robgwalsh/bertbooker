import { SEATSAERO_MAX_PAGES } from "../../models/wire/seatsaero.js";
import { MAX_DESTINATIONS, MAX_ORIGINS, MAX_VIA } from "../../models/route.js";
import type { RoutePair, RouteSpec } from "../../models/route.js";
import type { CallEstimate, RouteLegGroup, RoutePlan } from "../../models/route.js";

/**
 * Turning a tracked route's SET of city pairs into the queries a search
 * issues, and what they cost.
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
 *
 * Lives here rather than as a `models/route.ts` function because every one of
 * them is an opinion about award search: what a route expands to, which of
 * those pairs a coverage claim may cover, how a hub splits one route into two
 * queries, and what the whole thing costs in metered calls. Four slices call
 * in — `features/search/run.ts`, `features/alerts/alertRoutes.ts`,
 * `features/trackedRoutes/autoVia.ts`, `features/graph/reach.ts` — and none of
 * them owns it, which is why it is its own slice rather than folded into one
 * of theirs.
 */

/** Uppercase, trim, drop blanks, dedupe, and sort.
 *
 *  Sorting is not cosmetic: `seatsAeroTaskKey` is built from these lists, and
 *  a resumed pass indexes into this list by count. Without a stable
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

/**
 * What one search will ask for: the airports to send, and every pair that
 * answers to. Resolved once so the query, the coverage claim and the estimate
 * cannot drift apart.
 *
 * Throws `RouteSpecError` on a spec the user should not have been allowed to
 * save — callers turn that into a 400, never an empty result.
 */
export function planRoute(spec: RouteSpec, roundTrip = false, via?: readonly string[]): RoutePlan {
  const { origins, destinations } = searchSpec(spec, roundTrip);

  // Hubs are ignored on a round trip, and silently rather than by throwing: a
  // route can be flipped to round trip long after its hubs were filled in, and
  // refusing to plan it would break a search over a setting the form does not
  // even offer. Four query groups and a pairing of pairings is a different
  // feature; until it exists this is the honest reading.
  const hubs = roundTrip ? [] : viaFor(origins, destinations, via);

  if (!hubs.length) {
    const pairs = pairsOf(origins, destinations);
    return { origins, destinations, pairs, groups: [{ role: "direct", origins, destinations, pairs }] };
  }

  // The outbound query carries the DIRECT pair too, because the hubs simply join
  // its destination list and `pairsOf` drops nothing that matters. So the pair a
  // route is named for is still asked about every search, at no extra call —
  // which is what lets a hub route notice the day a program starts flying it.
  const outboundTo = normalizeAirports([...destinations, ...hubs]);
  const groups: RouteLegGroup[] = [
    {
      role: "outbound",
      origins,
      destinations: outboundTo,
      pairs: pairsOf(origins, outboundTo),
    },
    { role: "inbound", origins: hubs, destinations, pairs: pairsOf(hubs, destinations) },
  ];

  return { origins, destinations, pairs: dedupePairs(groups.flatMap((g) => g.pairs)), groups };
}

/**
 * The hubs a plan will actually use: normalized, capped, and with anything that
 * is already an endpoint removed.
 *
 * A hub that is one of the route's own airports is not a connection through the
 * route, it is a leg of it — and left in, it would put `SFO` on both sides of
 * the outbound query and ask for pairs `pairsOf` then drops, wasting rows on
 * nothing. Truncates rather than throws: hubs are filled in automatically, and a
 * route must never become unsearchable because the graph offered a fourth one.
 */
function viaFor(
  origins: readonly string[],
  destinations: readonly string[],
  via?: readonly string[],
): string[] {
  const endpoints = new Set([...origins, ...destinations]);
  return normalizeAirports(via).filter((code) => !endpoints.has(code)).slice(0, MAX_VIA);
}

const dedupePairs = (pairs: readonly RoutePair[]): RoutePair[] => {
  const seen = new Map<string, RoutePair>();
  for (const p of pairs) seen.set(`${p.origin}>${p.destination}`, p);
  return [...seen.values()];
};

/**
 * How many seats.aero queries one date chunk of this route costs.
 *
 * The multiplier between "date chunks" and "tasks", which is the unit everything
 * downstream budgets in. Never throws: it is called to PRICE a route, and one
 * route the normalizer refuses must not take the Alerts tab's arithmetic down
 * with it. A route that cannot be planned costs the same as a plain one, which
 * is the harmless direction — it will fail to plan long before it spends.
 */
export function queryGroupCount(
  spec: RouteSpec,
  roundTrip = false,
  via?: readonly string[],
): number {
  try {
    return planRoute(spec, roundTrip, via).groups.length;
  } catch {
    return 1;
  }
}

/** Every city pair a search touches, round trip and hubs included. */
export function searchPairs(
  spec: RouteSpec,
  roundTrip = false,
  via?: readonly string[],
): RoutePair[] {
  return planRoute(spec, roundTrip, via).pairs;
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
  via?: readonly string[],
): CallEstimate {
  const plan = planRoute(spec, roundTrip, via);
  const groups = plan.groups.length;
  const tasks = chunks * groups;
  return {
    // Round trip raises the pair count and leaves the call counts alone, which
    // is the honest shape of it: both directions ride in the same call. HUBS do
    // not — they are separate markets, so they raise `groups`, and that is the
    // whole difference between the two settings' economics.
    pairs: plan.pairs.length,
    groups,
    tasks,
    floor: tasks,
    ceiling: tasks * SEATSAERO_MAX_PAGES,
  };
}
