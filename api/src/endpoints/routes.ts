import { Hono } from "hono";
import { PORTAL_CURRENCIES } from "../domain/programs.js";
import type { Env, Vars } from "../bindings.js";
import type { Find, RoutesData, TrackedRoute } from "../../../shared/src/wire/index.js";
import type { ScopedRoute } from "../db/finds.js";
import {
  FIND_COLUMNS,
  ROUTE_FINDS_MATCH,
  ROUTE_FINDS_SEATS,
  findsCte,
  routeFindsScope,
} from "../db/finds.js";

/**
 * The Routes page's whole payload: the user's monitors, and the current best
 * finds tied to each.
 *
 * **The only reader of `findsCte`.** A change to that CTE is exercised by the
 * surface that matters rather than by an endpoint nobody is watching. See
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
  const email = c.get("userEmail");
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
        " FROM tracked_routes WHERE user_email = ? ORDER BY created_at DESC",
  )
    .bind(email)
    .all<TrackedRoute & ScopedRoute>();

  // The route-set and date columns the scope needs are already in the list
  // above — they are what the Routes page draws a route's shape from — so this
  // adds no columns and the warning up there still names the same list.
  const pageFinds = findsCte(routeFindsScope(routeRows.results ?? []));

  // Current finds, tied to the routes that monitor them. `findsCte` collapses
  // the per-source snapshot history into one current row per
  // (route_key, program, cabin) — see finds.ts for why that collapse now
  // happens at read time — and this joins the result to the user's
  // tracked_routes by origin + destination + date window, constrained to each
  // route's own cabin and min-seats. Tagged with tracked_route_id so the UI
  // can nest each find under its route; a find overlapping two routes'
  // windows appears under both.
  const findRows = await c.env.DB.prepare(
    `${pageFinds.sql}
       SELECT tr.id AS tracked_route_id, ${FIND_COLUMNS}
         FROM finds f
         JOIN tracked_routes tr
           ON tr.user_email = ?
          -- "Does this find belong to this route, and pass its filters?" —
          -- shared verbatim with the alert sweep, which asks the identical
          -- question about one route. See ROUTE_FINDS_MATCH in finds.ts for why
          -- that sharing is load-bearing rather than tidy.
          AND ${ROUTE_FINDS_MATCH}
        WHERE ${ROUTE_FINDS_SEATS}
        ORDER BY tr.id, f.flight_date ASC, f.seats_available DESC, f.miles_cost ASC`,
  )
    .bind(...pageFinds.binds, email, JSON.stringify(PORTAL_CURRENCIES))
    .all<Find>();

  // The annotation buys the envelope: a renamed or dropped key is a compile
  // error here rather than an empty pane in the SPA. `.all<T>()` is an unchecked
  // assertion either way — see the note on `wire/rows.ts` in CLAUDE.md.
  const body: RoutesData = {
    trackedRoutes: (routeRows.results ?? []) as TrackedRoute[],
    bestFinds: findRows.results ?? [],
  };
  return c.json(body);
});

