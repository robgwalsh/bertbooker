/**
 * A tracked route as a SET of city pairs, not one pair — the shape only. The
 * planner that turns a spec into queries (`normalizeSpec`, `planRoute`,
 * `searchPairs`, `estimateSearchCalls`, and the rest) lives in
 * `api/src/features/routing/plan.ts` now: every one of those functions is an
 * opinion about award search, not a detail of this shape, and four slices
 * (`search`, `alerts`, `trackedRoutes`, `graph`) call into it with none of
 * them owning it — the same reason this used to be a model rather than a util
 * before `models/` held only types.
 */

// `RoutePair`, `RouteSpec`, `RouteLegRole` and the three caps are declared in
// `api/src/models/wire/routing.ts` and re-exported here, so every consumer of
// this module sees them in one place. The SPA reads all four; the caps are
// VALUES rather than types, so they carry runtime code, not just type
// information.
export { MAX_DESTINATIONS, MAX_ORIGINS, MAX_VIA } from "./wire/routing.js";
export type { RouteLegRole, RoutePair, RouteSpec } from "./wire/routing.js";

import type { RouteLegRole, RoutePair, RouteSpec } from "./wire/routing.js";

/**
 * One seats.aero QUERY: a pair of airport lists, and the pairs it answers for.
 *
 * A route used to be exactly one of these, because the whole cross product rides
 * in a single call. Hubs break that — not for cost but for arithmetic. `SFO->ICN`
 * and `ICN->KTM` are different markets, and no single pair of lists names both
 * without also naming hub-to-hub pairs nobody asked for. Two lists cannot
 * express a path, so a path is two queries.
 */
export interface RouteLegGroup {
  /** `direct` is the whole of a route with no hubs. The other two are the halves
   *  of a route with them, and the name reaches `seatsAeroTaskKey` so two groups
   *  over one date range stay distinguishable. */
  role: RouteLegRole;
  origins: string[];
  destinations: string[];
  /** What this query's coverage claim is made of. */
  pairs: RoutePair[];
}

export interface RoutePlan extends Required<RouteSpec> {
  /** What the coverage claim is made of. For a round trip this holds BOTH
   *  directions, which is what lets one task claim both. The union of the
   *  groups' pairs, deduped. */
  pairs: RoutePair[];
  /** The queries to issue per date chunk. One without hubs, two with them. */
  groups: RouteLegGroup[];
}

export interface CallEstimate {
  pairs: number;
  /** Queries per date chunk: 1 without hubs, 2 with them. The multiplier both
   *  ends below are missing without it. */
  groups: number;
  /** Tasks the search plans — `chunks * groups`, and the unit everything
   *  downstream counts in. `runs.tasks_planned` is this number. */
  tasks: number;
  /** One call per TASK — what a search costs when every query fits in a single
   *  page. */
  floor: number;
  /** Every task paginating to `SEATSAERO_MAX_PAGES`. Reachable on a wide route
   *  over a long window, and the point at which coverage starts narrowing. */
  ceiling: number;
}
