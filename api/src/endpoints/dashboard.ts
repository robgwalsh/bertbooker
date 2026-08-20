import { Hono } from "hono";
import { PORTAL_CURRENCIES } from "../domain/programs.js";
import type { Env, Vars } from "../bindings.js";
import type { DashboardData, Find, TrackedRoute } from "../../../shared/src/wire/index.js";
import { FIND_COLUMNS, ROUTE_FINDS_MATCH, ROUTE_FINDS_SEATS, findsCte } from "../db/finds.js";

/**
 * The Routes page's whole payload: the user's monitors, and the current best
 * finds tied to each.
 *
 * **The only reader of `findsCte`.** A change to that CTE is exercised by the
 * surface that matters rather than by an endpoint nobody is watching. See
 * `db/finds.ts`.
 */
export const dashboard = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- Dashboard: monitors + best current finds ----
dashboard.get("/api/dashboard", async (c) => {
  const email = c.get("userEmail");
  // Unscoped: the dashboard's join is what narrows to the user's routes, so the
  // collapse has to see every route they might be tracking. This is the one
  // caller that can't push a scope predicate down into the CTE.
  const dashboardFinds = findsCte({ where: [], binds: [] });
  // NOTE: this batch is read POSITIONALLY below. Adding or removing a statement
  // here means the destructuring on the other side has to move with it, and
  // **nothing in the type system will notice** — `batch<T>()` is homogeneous by
  // signature, so there is no way to give element 0 and element 1 different
  // types short of splitting this into two round trips.
  //
  // Annotating the response `DashboardData` (below) checks the ENVELOPE and the
  // two array element types; it cannot check the ORDER. Destructuring by name
  // rather than indexing is as far as this goes. **This comment is the guard.**
  const [routeRows, findRows] = await c.env.DB.batch([
    c.env.DB.prepare(
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
        " date_start, date_end, cabins, currencies, min_seats, direct_only, round_trip," +
        " last_checked_at," +
        " alerts_enabled, alert_email, alert_on, alert_min_drop_pct," +
        " alert_last_attempt_at, alert_last_digest_at, alert_consecutive_failures" +
        " FROM tracked_routes WHERE user_email = ? ORDER BY created_at DESC",
    ).bind(email),
    // Current finds, tied to the routes that monitor them. `findsCte` collapses
    // the per-source snapshot history into one current row per
    // (route_key, program, cabin) — see finds.ts for why that collapse now
    // happens at read time — and this joins the result to the user's
    // tracked_routes by origin + destination + date window, constrained to each
    // route's own cabin and min-seats. Tagged with tracked_route_id so the UI
    // can nest each find under its route; a find overlapping two routes'
    // windows appears under both.
    c.env.DB.prepare(
      `${dashboardFinds.sql}
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
    ).bind(...dashboardFinds.binds, email, JSON.stringify(PORTAL_CURRENCIES)),
  ]);
  // The casts are exactly what was already happening implicitly — `batch()`
  // hands back untyped rows either way. What the annotation buys is the
  // envelope: a renamed or dropped key is now a compile error here rather than
  // an empty pane in the SPA.
  const body: DashboardData = {
    trackedRoutes: (routeRows?.results ?? []) as TrackedRoute[],
    bestFinds: (findRows?.results ?? []) as Find[],
  };
  return c.json(body);
});

