import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { Find, RoutesData, TrackedRoute } from "../models/wire/index.js";
import { selectRouteFinds } from "../db/finds.js";
import { selectRoutesForPage } from "../db/trackedRoutes.js";
import { routeMatcher } from "../features/search/routeMatch.js";

/**
 * The Routes page's whole payload: the user's monitors, and the current best
 * finds tied to each.
 *
 * One of two readers of the scoped find query; the alert sweep is the other. See
 * `db/finds.ts`.
 *
 * **This file is the PAGE; `tracked-routes-endpoints.ts` is the ROUTES themselves.** The
 * split is the reason two files here both sound like they own the same word:
 * this one answers "draw me the Routes page" in a single request, while that one
 * owns the CRUD on `/api/tracked-routes/:id`. The directory is called
 * `endpoints/` rather than `routes/` for the same collision — see CLAUDE.md.
 */
export const routes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- The Routes page: monitors + best current finds ----
routes.get("/api/routes", async (c) => {

  const routeRows = await selectRoutesForPage(c.env.DB);

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
  const matchingFinds: Find[] = [];
  for (const route of routeRows) {
    const matcher = routeMatcher(route);
    for (const f of found) {
      if (matcher.matches(f)) matchingFinds.push({ ...f, tracked_route_id: route.id });
    }
  }

  const body: RoutesData = {
    trackedRoutes: routeRows as TrackedRoute[],
    matchingFinds,
  };
  return c.json(body);
});
