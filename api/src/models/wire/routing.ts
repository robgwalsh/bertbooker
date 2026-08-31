// The route-shape vocabulary the SPA reads, and the two caps it enforces in the
// form before the Worker enforces them again.
//
// Split out of `../routing.ts` for exactly the reason `./seatsaero.ts` was split
// out of `../providers/seatsaero.ts`: that file is 190 lines of planning logic
// (`planRoute`, `roundTripSpec`, `estimateSearchCalls`) that runs only on the
// Worker, and the SPA needed four names out of it. Because two of those four are
// VALUES rather than types, `routing.ts` was the one module outside `wire/`
// whose runtime code reached the browser's module graph at all.
//
// `api/src/models/route.ts` re-exports everything here, so no `api/` import
// moved.

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
 * Which query of a route's plan a task belongs to.
 *
 * A route with no hubs plans one query and it is `direct`. A route with hubs
 * plans two — `outbound` from the origins to the hubs (and the destinations, so
 * the direct pair is still asked about), then `inbound` from the hubs to the
 * destinations. It cannot be one query: a cross product rides in a single call,
 * but `SFO->ICN` and `ICN->KTM` are different markets.
 *
 * Declared here rather than beside `RouteLegGroup` in `api/src/models/route.ts`
 * because the search stream carries it, and a wire frame may name nothing the
 * SPA cannot import.
 */
export type RouteLegRole = "direct" | "outbound" | "inbound";

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
 *
 * The route form offers at most this many airports a side, and the Worker
 * refuses more with a 400 `bad_route_spec`. The SPA held its own copies of both
 * numbers for as long as it could not import them.
 */
export const MAX_ORIGINS = 3;
export const MAX_DESTINATIONS = 3;

/**
 * Hubs a route may route THROUGH, and the one cap here that IS about spend.
 *
 * Unlike the two above, hubs do not ride in the same call: a cross product is
 * one query, but `SFO->ICN` and `ICN->KTM` are different markets, so a route
 * with hubs plans two queries per date range instead of one. Adding hubs past
 * that costs no further calls — they join the lists either side — so what this
 * bounds is ROWS. Three keeps the first query to four markets, which is what
 * keeps a busy pair inside `SEATSAERO_MAX_PAGES` rather than paginating out and
 * narrowing its own coverage claim.
 */
export const MAX_VIA = 3;
