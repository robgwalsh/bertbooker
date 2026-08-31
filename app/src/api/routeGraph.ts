import { req } from "./client";
import type {
  PairCoverage,
  PairPaths,
  ReachReport,
  RouteFetchResult,
  RouteGraphGeo,
  RouteGraphRow,
  RouteGraphSource,
} from "../../../api/src/models/wire/index.js";

/**
 * The seats.aero route graph — which pairs each program is monitored on.
 *
 * **Only `fetchRouteGraph` costs money**: one metered call out of the day's
 * 1000. Everything else reads what that call already bought, which is the whole
 * reason the graph is cached in D1 rather than proxied live.
 */

/**
 * Search criteria shared by the graph table and the graph map.
 *
 * Client-only, and deliberately not part of the wire contract: it describes how
 * to BUILD a query string, not a shape either side sends — the same rule
 * `AirportSearchOpts` follows. The Worker's end of it is `routeFilter`, the one
 * WHERE builder both routes share.
 */
export interface RouteGraphOpts {
  q?: string;
  origin?: string;
  destination?: string;
  originRegion?: string;
  destinationRegion?: string;
  minDistance?: number;
  maxDistance?: number;
  limit?: number;
}

function graphParams(source: string, opts?: RouteGraphOpts): string {
  const params = new URLSearchParams({ source });
  const set = (key: keyof RouteGraphOpts) => {
    const v = opts?.[key];
    if (v !== undefined && v !== "" && v !== null) params.set(key, String(v));
  };
  set("q");
  set("origin");
  set("destination");
  set("originRegion");
  set("destinationRegion");
  set("minDistance");
  set("maxDistance");
  set("limit");
  return params.toString();
}

/** Every source, what we know about it, and whether we hold its graph. */
export const routeGraphSources = () => req<RouteGraphSource[]>("/seatsaero/sources");

/** **METERED — one seats.aero call.** Replaces this source's stored graph. */
export const fetchRouteGraph = (source: string) =>
  req<RouteFetchResult>(`/seatsaero/sources/${encodeURIComponent(source)}/fetch`, {
    method: "POST",
  });

/** The capped table read. */
export const routeGraph = (source: string, opts?: RouteGraphOpts) =>
  req<RouteGraphRow[]>(`/seatsaero/routes?${graphParams(source, opts)}`);

// Same criteria, slim columns and coordinates joined on — the table lists the
// top matches while the map draws the whole matching set.
export const routeGraphGeo = (source: string, opts?: RouteGraphOpts) =>
  req<RouteGraphGeo>(`/seatsaero/routes/geo?${graphParams(source, opts)}`);

/** Who flies this pair, across every fetched source, both directions. */
export const routeGraphPair = (origin: string, destination: string) =>
  req<PairCoverage>(
    `/seatsaero/routes/pair?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`,
  );

/**
 * How you would get there with a stop, when nobody monitors the pair itself.
 *
 * Separate from `routeGraphPair` rather than folded into it: the direct answer
 * is one indexed lookup and this walks a self-join, so a pane that wants only
 * the first should not pay for the second.
 */
export const routeGraphPaths = (origin: string, destination: string) =>
  req<PairPaths>(
    `/seatsaero/routes/paths?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`,
  );

/** Whether the routes you track go anywhere anyone's graph reaches. */
export const routeGraphReach = () => req<ReachReport>("/seatsaero/reach");
