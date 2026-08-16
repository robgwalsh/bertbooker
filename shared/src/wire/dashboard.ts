import type { Find, TrackedRoute } from "./rows.js";

/** `GET /api/dashboard` — every tracked route plus every current find under it,
 *  each tagged with its `tracked_route_id`. Still called "dashboard" on the wire
 *  after the page became **Routes**: the endpoint's name is not the page's, and
 *  renaming it would move the Worker route, three query-key invalidations and
 *  nothing else. One request for all routes is deliberate — it is what lets the
 *  route rail show a find count per route without a query each.
 *
 *  The Worker builds this from a `batch()`, reading the two result sets
 *  POSITIONALLY. Annotating the envelope here checks the SHAPE but cannot check
 *  the ORDER — `batch<T>()` is homogeneous by signature, so nothing in the type
 *  system can notice the two halves being swapped. See the NOTE at the call
 *  site; it is the only guard there is. */
export interface DashboardData {
  trackedRoutes: TrackedRoute[];
  bestFinds: Find[];
}
