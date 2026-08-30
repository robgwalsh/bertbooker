import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { Find, RoutesData, TrackedRoute } from "../../../shared/src/wire/index.js";
import type { ScopedRoute } from "../db/finds.js";
import { FIND_COLUMNS, findsFrom, routeFindsScope } from "../db/finds.js";
import { routeMatcher } from "../../../shared/src/match/routeMatch.js";

/**
 * The Routes page's whole payload: the user's monitors, and the current best
 * finds tied to each.
 *
 * One of two readers of `findsFrom`; the alert sweep is the other. See
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
  const routeRows = await c.env.DB.prepare(
      // The route-SET columns must be in this list. They are
      // what the Routes page draws the route's shape from, and an explicit
      // column list is exactly the kind that gets forgotten when a schema
      // change adds one: omitting them doesn't fail, it silently renders every
      // multi-airport route as a plain single-pair route.
      //
      // Since the header edits the route in place, this list is ALSO what the
      // edit form is seeded from — every settable column has to be here or its
      // field opens showing a default the row does not hold. `PATCH` merges
      // against the stored row, so the damage stops at the form; but a switch
      // that renders "off" for a route that is on is its own bug.
      //
      // The alert columns are exactly the case that warning was written about,
      // and they were missing from it. The edit dialog sends `alertsEnabled` on
      // every save rather than omitting it, so a form seeded from an absent
      // column sent `false` and QUIETLY UNENROLLED the route — and re-enabling
      // it afterwards re-ran `baselineOnEnable`, moving the digest clock too.
      // The last three are state rather than settings, and are here because the
      // Routes page draws a route's alert health beside it (see app/src/lib/alerts.ts).
      "SELECT id, origin, destination, origins, destinations, via," +
        " date_start, date_end, cabins, currencies, min_seats, direct_only, point_limit," +
        " round_trip," +
        " last_checked_at," +
        " alerts_enabled, alert_email, alert_on, alert_min_drop_pct," +
        " alert_last_attempt_at, alert_last_digest_at, alert_consecutive_failures" +
        " FROM tracked_routes ORDER BY created_at DESC",
  )
    .all<TrackedRoute & ScopedRoute>();

  // The route-set and date columns the scope needs are already in the list
  // above — they are what the Routes page draws a route's shape from — so this
  // adds no columns and the warning up there still names the same list.
  const pageFinds = findsFrom(routeFindsScope(routeRows.results ?? []));

  // Current finds. The scope predicate bounds this to a provable superset of
  // what any of the user's routes could show (see `routeFindsScope`); the
  // tagging below is what narrows it to the exact set.
  //
  // This used to JOIN tracked_routes and do the narrowing in SQL. That
  // predicate is all json_each, so no index could serve it and the plan was a
  // nested loop — cost O(routes x finds), measured at 49,512 rows, 57% of the
  // whole query, and the only term that grew when a route was added.
  const findRows = await c.env.DB.prepare(
    `SELECT ${FIND_COLUMNS} ${pageFinds.sql}`,
  )
    .bind(...pageFinds.binds)
    .all<Find>();

  // Reproduces the ORDER BY this query used to carry. Its SORT is dead —
  // FindsTable re-sorts the whole set client-side — but its DETERMINISM is not:
  // `findKey` (app/src/pages/routes/findKey.ts) builds React keys from the
  // paginated index, so an unordered read lets a refetch reshuffle which find
  // sits at which index.
  const found = [...(findRows.results ?? [])].sort(
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
  for (const route of routeRows.results ?? []) {
    const matcher = routeMatcher(route);
    for (const f of found) {
      if (matcher.matches(f)) bestFinds.push({ ...f, tracked_route_id: route.id });
    }
  }

  // The annotation buys the envelope: a renamed or dropped key is a compile
  // error here rather than an empty pane in the SPA. `.all<T>()` is an unchecked
  // assertion either way — see the note on `wire/rows.ts` in CLAUDE.md.
  const body: RoutesData = {
    trackedRoutes: (routeRows.results ?? []) as TrackedRoute[],
    bestFinds,
  };
  return c.json(body);
});

