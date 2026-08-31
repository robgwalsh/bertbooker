import type { RouteFetchStatus } from "./wire/routeGraph.js";

/**
 * THE SEATS.AERO ROUTE GRAPH — the city pairs each program's award inventory is
 * monitored on, as the Worker stores and queries them.
 *
 * A pair here is a claim about which markets seats.aero WATCHES. It is not
 * availability and it never licenses a prune: `docs/SEATS-AERO.md` §12 is
 * explicit that reach is not coverage.
 *
 * The statements are `db/routeGraph.ts`; what the pane renders — `RouteGraphRow`,
 * `RouteGraphEdge`, `PairCoverage`, `GraphPath`, `ReachReport` — are WIRE types
 * in `api/src/models/wire/routeGraph.ts`. `RouteFetchStatus` is one of those, and is
 * imported rather than restated because `RouteFetchOutcome` below is what
 * produces the value the SPA reads.
 */

/** What one `/routes` call did, recorded whether it stored anything or not.
 *
 *  Written for a `failed` call too, and that is the point: without the row,
 *  "no routes for X" means either "we never asked" or "that name is wrong", and
 *  nothing downstream can tell which. `empty` is a SUCCESS. */
export interface RouteFetchOutcome {
  status: RouteFetchStatus;
  routeCount: number;
  duplicates: number;
  malformed: number;
  fetchedAt: number;
  durationMs?: number | null;
  httpStatus?: number | null;
  bytes?: number | null;
  error?: string | null;
}

/** One monitored edge: a pair, and the source that flies it. */
export interface GraphPair {
  origin: string;
  destination: string;
  source: string;
}

/** One pair to search paths for, with the budget its own great circle earns. */
export interface PathQueryPair {
  origin: string;
  destination: string;
  /** Total STORED `distance_mi` a path may span, or null for no bound (the pair
   *  has no coordinates, so no budget can be computed). A cheap pre-filter, not
   *  the authority: `distance_mi` has zeros, so this only ever lets too much
   *  through, which `rankPaths` then judges properly. */
  budgetMi: number | null;
}

/** One hub sequence for one asked pair, with the source flying each leg. */
export interface GraphPathRow {
  origin: string;
  destination: string;
  via: string[];
  /** One per leg, so `via.length + 1` of them. */
  legSources: string[];
}

/** A row of the cross-source pair lookup — who flies this pair, either way
 *  round. Produced by `selectPairSources`. */
export interface PairSourceRow {
  source: string;
  origin: string;
  destination: string;
  distance_mi: number | null;
}
