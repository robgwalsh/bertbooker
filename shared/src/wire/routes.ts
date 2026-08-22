import type { Find, TrackedRoute } from "./rows.js";

/** `GET /api/routes` — the Routes page's whole payload: every tracked route plus
 *  every current find under it, each tagged with its `tracked_route_id`.
 *
 *  **Not the same thing as `GET /api/tracked-routes`**, which returns the route
 *  rows alone. This is the page, that is the list — and the page is the one with
 *  a reader. One request for all routes is deliberate: it is what lets the route
 *  rail show a find count per route without a query each.
 *
 *  The Worker reads the routes first and the finds second, because the finds
 *  query is SCOPED to the airports and date windows those routes cover — see
 *  `routeFindsScope` in `api/src/db/finds.ts`. */
export interface RoutesData {
  trackedRoutes: TrackedRoute[];
  bestFinds: Find[];
}
