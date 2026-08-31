/**
 * "Does this find belong to this tracked route, and does it pass the route's own
 * filters?" — the one definition, shared by the Routes page and the alert sweep.
 *
 * This was SQL — a correlated predicate in `api/src/db/finds.ts` — asking the same
 * question as a correlated predicate over `finds f` and `tracked_routes tr`, and
 * the two callers shared its text so they could not drift. That sharing is the
 * load-bearing part and it survives here unchanged: an alert that fired on a
 * find the route's own pane hides is indistinguishable from a bug in either
 * half.
 *
 * WHY IT LEFT SQL. The predicate is built entirely of `json_each` EXISTS
 * subqueries, so no index can serve the join — the plan was a nested loop with
 * `SCAN tr` outside and `SCAN f` inside, cost O(routes x finds). Measured on
 * production at six routes over 5,768 in-scope finds, the join and its
 * `ORDER BY` were 49,512 rows read, 57% of the whole query. Every other term is
 * O(finds); this was the only one that grew with a dimension the user adds to by
 * clicking "add route".
 *
 * WHAT DID NOT MOVE. `routeFindsScope` (api/src/db/finds.ts) still bounds the
 * D1 read to a provable superset of what this predicate can accept, and it must:
 * this runs over rows already fetched, so a scope that excludes a matching find
 * drops it silently. The two are a pair — a branch added below without a
 * matching widening there is invisible.
 *
 * THREE PLACES THIS DELIBERATELY DIFFERS FROM THE SQL IT REPLACES, all of them
 * unreachable through the API today and all of them chosen so a legacy row
 * cannot diverge:
 *
 *  - A filter column holding `[]` matches NOTHING, exactly as `EXISTS` over zero
 *    `json_each` rows did. `legFilter` in app/src/lib/multiLeg.ts read `[]` as
 *    "no filter", which is the opposite. `endpoints/tracked-routes-endpoints.ts` normalises
 *    empty arrays to NULL on POST and PATCH, so only a legacy row could tell.
 *  - A find with NULL `transfer_currencies` is excluded by a currency-filtered
 *    route, because `json_each(NULL)` yields no rows to intersect.
 *  - MALFORMED JSON is read as "no filter". The SQL raised a SQLite error and
 *    failed the whole request; blanking the Routes page over one bad column is
 *    worse than showing an unfiltered row, and it matches what the SPA already
 *    did.
 *
 * Note the hub branches are NOT gated on `round_trip`, even though `planRoute`
 * (api/src/models/route.ts) ignores `via` for round trips. That is the SQL's
 * behaviour and it is the right one here: this reads what was GATHERED, and a
 * route that was searched with hubs before round-trip was turned on still has
 * those legs stored.
 */

/**
 * The `tracked_routes` columns the predicate reads. Structurally satisfied by
 * the wire `TrackedRoute` and by the Worker's own route row, so neither side
 * needs a conversion or an extra query.
 */
export interface MatchableRoute {
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  via: string | null;
  date_start: string;
  date_end: string;
  round_trip: number;
  cabins: string | null;
  currencies: string | null;
  direct_only: number;
  point_limit: number | null;
  min_seats: number;
}

/**
 * The find columns the predicate reads — and the reason the alert sweep can ask
 * for nine columns instead of the twenty-one `FIND_COLUMNS` projects.
 */
export interface MatchableFind {
  origin: string;
  destination: string;
  flight_date: string;
  cabin: string;
  /** Absent and null are the same answer: a currency-filtered route excludes the
   *  find, because there is nothing to intersect. The wire `Find` declares this
   *  optional and the D1 row reads it as nullable, so both spellings arrive. */
  transfer_currencies?: string | null;
  is_direct: number;
  miles_cost: number;
  seats_available: number;
}

/**
 * One side of a route's airport SET, from the JSON column with the scalar as
 * fallback. `origins`/`destinations` are authoritative; `origin`/`destination`
 * are the route's PRIMARY airport each side, so a row carrying no array has the
 * scalar as its whole set.
 */
function codeSet(json: string | null, fallback: string): Set<string> {
  if (json) {
    try {
      const v: unknown = JSON.parse(json);
      if (Array.isArray(v) && v.length) return new Set(v.map(String));
    } catch {
      /* fall through to the scalar */
    }
  }
  return new Set(fallback ? [fallback] : []);
}

/**
 * A FILTER column, where `null` means "no filter" and an empty set means "match
 * nothing" — the distinction `parseCodeList` throws away and the SQL depended
 * on. See the header.
 */
function filterSet(json: string | null | undefined): Set<string> | null {
  if (json == null) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    return new Set(v.map(String));
  } catch {
    return null;
  }
}

/** The hubs a route routes through. Absent and empty are the same answer here:
 *  neither hub branch can match without one. */
function hubSet(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? new Set(v.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Add days to an ISO date (YYYY-MM-DD), in UTC so a daylight-saving boundary
 * cannot shift the calendar day — the result is compared against `flight_date`,
 * which has no time in it at all.
 *
 * Mirrors `addDaysISO` in api/src/util/dates.ts and app/src/lib/routeShape.ts.
 * Kept as a copy for the same reason routeShape.ts states: `domain/window.ts`
 * is Worker-side and not part of what the SPA may import.
 */
export function addDaysISO(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A route's parsed shape, so a caller matching many finds against one route (the
 * sweep) or many finds against a few routes (the Routes page) parses each JSON
 * column once rather than once per find.
 */
export interface RouteMatcher {
  route: MatchableRoute;
  matches(find: MatchableFind): boolean;
}

/** Parse a route once, then test finds against it. */
export function routeMatcher(route: MatchableRoute): RouteMatcher {
  const origins = codeSet(route.origins, route.origin);
  const destinations = codeSet(route.destinations, route.destination);
  const via = hubSet(route.via);
  const cabins = filterSet(route.cabins);
  const currencies = filterSet(route.currencies);
  // The second hub leg may depart the day AFTER the window closes: an overnight
  // in the hub on the last gathered date is a real journey, and the shared
  // window test would clip exactly it. The one day mirrors
  // DEFAULT_MAX_CONNECT_DAYS in app/src/lib/multiLeg.ts, which decides whether
  // the pair actually joins; widening one without the other only wastes rows.
  const secondLegEnd = addDaysISO(route.date_end, 1);

  const inWindow = (date: string): boolean =>
    date >= route.date_start && date <= route.date_end;

  return {
    route,
    matches(f: MatchableFind): boolean {
      const forward = origins.has(f.origin) && destinations.has(f.destination);
      // A round trip matches the REVERSED pair too, and must: its search
      // deliberately gathered HND->SEA alongside SEA->HND in one call, so
      // without this those return legs would be stored, claimed as covered, and
      // invisible.
      const reversed =
        route.round_trip === 1 && destinations.has(f.origin) && origins.has(f.destination);
      const firstLeg = origins.has(f.origin) && via.has(f.destination);
      const secondLeg = via.has(f.origin) && destinations.has(f.destination);

      const belongs =
        ((forward || reversed) && inWindow(f.flight_date)) ||
        (firstLeg && inWindow(f.flight_date)) ||
        (secondLeg && f.flight_date >= route.date_start && f.flight_date <= secondLegEnd);
      if (!belongs) return false;

      if (f.seats_available < route.min_seats) return false;
      if (route.direct_only !== 0 && f.is_direct !== 1) return false;
      // Compared against miles_cost, which quotes the CHEAPEST itinerary of any
      // shape for this slot — not direct_miles_cost, which is what the nonstop
      // costs when a dearer one exists. So a route capped at 100k with
      // nonstop-only on can show a row whose nonstop price is above the cap.
      if (route.point_limit != null && f.miles_cost > route.point_limit) return false;
      if (cabins && !cabins.has(f.cabin)) return false;
      if (currencies) {
        const held = filterSet(f.transfer_currencies);
        if (!held) return false;
        let hit = false;
        for (const c of held) {
          if (currencies.has(c)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      return true;
    },
  };
}

/** The predicate for a single (find, route) pair. Prefer `routeMatcher` when
 *  testing more than one find against the same route. */
export function matchesRoute(find: MatchableFind, route: MatchableRoute): boolean {
  return routeMatcher(route).matches(find);
}
