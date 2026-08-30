import { Hono } from "hono";
import type { Env, Vars } from "../../bindings.js";
import type { Find, RoutesData, TrackedRoute } from "../../../../shared/src/wire/index.js";
import { selectRouteFinds } from "../../db/finds.js";
import { selectRoutesForPage } from "../../db/trackedRoutes.js";
import { routeMatcher } from "../../../../shared/src/match/routeMatch.js";

/**
 * The Routes page's whole payload: the user's monitors, and the current best
 * finds tied to each.
 *
 * One of two readers of the scoped find query; the alert sweep is the other. See
 * `db/finds.ts`.
 *
 * **This file is the PAGE; `trackedRoutes.ts` is the ROUTES themselves.** The
 * split is the reason two files here both sound like they own the same word:
 * this one answers "draw me the Routes page" in a single request, while that one
 * owns the CRUD on `/api/tracked-routes/:id`. The directory is called
 * `endpoints/` rather than `routes/` for the same collision — see CLAUDE.md.
 */
export const routes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- The Routes page: monitors + best current finds ----
routes.get("/api/routes", async (c) => {
  // TWO round trips, not one `batch()`, and the second depends on the first:
  // the finds query is SCOPED to the airports and date windows these routes
  // actually cover, and there is no way to read route rows out of a batch that
  // has not run yet.
  //
  // This endpoint used to say it "can't push a scope predicate down into the
  // CTE" because its join is what narrows to the user's routes. That was wrong
  // in the direction that costs money: the join narrows the OUTPUT, while the
  // collapse underneath it was grouping every snapshot in the database first.
  // The union over the user's own routes is a superset of anything that join
  // can emit, so pushing it down changes no row — it only stops the query
  // paying for snapshots belonging to routes that no longer exist (a quarter of
  // the table, at the time of writing).
  //
  // The extra round trip is worth naming: it costs a few ms in-colo, reads the
  // same six rows either way, and it retires the positional-`batch()` hazard
  // that used to need a fourteen-line comment here to guard — `batch<T>()` is
  // homogeneous by signature, so nothing in the type system ever checked that
  // element 0 was the routes and element 1 the finds.
  const routeRows = await selectRoutesForPage(c.env.DB);

  // Current finds. The scope predicate bounds this to a provable superset of
  // what any of the user's routes could show (see `routeFindsScope`); the
  // tagging below is what narrows it to the exact set.
  //
  // This used to JOIN tracked_routes and do the narrowing in SQL. That
  // predicate is all json_each, so no index could serve it and the plan was a
  // nested loop — cost O(routes x finds), measured at 49,512 rows, 57% of the
  // whole query, and the only term that grew when a route was added.
  const findRows = await selectRouteFinds(c.env.DB, routeRows);

  // Reproduces the ORDER BY this query used to carry. Its SORT is dead —
  // FindsTable re-sorts the whole set client-side — but its DETERMINISM is not:
  // `findKey` (app/src/pages/routes/findKey.ts) builds React keys from the
  // paginated index, so an unordered read lets a refetch reshuffle which find
  // sits at which index.
  const found = [...findRows].sort(
    (a, b) =>
      a.flight_date.localeCompare(b.flight_date) ||
      b.seats_available - a.seats_available ||
      a.miles_cost - b.miles_cost,
  );

  // Tag each find with every route that would show it. One row per
  // (find, route) pair exactly as the join emitted — a find overlapping two
  // routes' windows still appears under both, and the SPA still groups by
  // `tracked_route_id`. Routes are the outer loop so the payload stays grouped
  // by route, which is the order the join produced.
  const bestFinds: Find[] = [];
  for (const route of routeRows) {
    const matcher = routeMatcher(route);
    for (const f of found) {
      if (matcher.matches(f)) bestFinds.push({ ...f, tracked_route_id: route.id });
    }
  }

  // The annotation buys the envelope: a renamed or dropped key is a compile
  // error here rather than an empty pane in the SPA. `.all<T>()` is an unchecked
  // assertion either way — see the note on `wire/rows.ts` in CLAUDE.md.
  const body: RoutesData = {
    trackedRoutes: routeRows as TrackedRoute[],
    bestFinds,
  };
  return c.json(body);
});
