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

  const routeRows = await selectRoutesForPage(c.env.DB);

  // Current finds. The scope predicate bounds this to a provable superset of
  // what any of the user's routes could show (see `routeFindsScope`); the
  // tagging below is what narrows it to the exact set.
  const findRows = await selectRouteFinds(c.env.DB, routeRows);

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
