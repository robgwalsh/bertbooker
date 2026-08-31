import type { AlertRouteCost } from "./pace.js";
import { planSeatsAeroChunks } from "../../providers/seatsaero.js";
import { queryGroupCount } from "../../models/route.js";
import type { Env } from "../../bindings.js";
import { selectAlertRoutes } from "../../db/trackedRoutes.js";
import type { AlertRouteRow } from "../../models/trackedRoute.js";

/**
 * An alert route as the two surfaces that list them see it: its row, what it
 * costs a sweep, and what to call it.
 *
 * Read by BOTH the scheduler (`tick.ts`) and the Alerts tab
 * (`endpoints.ts`), which is the whole reason it is a module. docs/ALERTS.md §4
 * is explicit that a page quoting a cadence the scheduler does not keep is worse
 * than no number at all, so the cost model has to be one implementation.
 */

/** Declared in `models/trackedRoute.ts` with the table's other projections, and
 *  re-exported here because this module is what both surfaces read it through. */
export type { AlertRouteRow } from "../../models/trackedRoute.js";

/** A JSON list column, with the scalar fallback. Mirrors `codeList` in
 *  `db/finds.ts`. */
export function parseList(json: string | null, fallback?: string): string[] {
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
    } catch {
      /* fall through */
    }
  }
  return fallback ? [fallback] : [];
}

/**
 * Every alert-enabled route, with the two things pacing needs alongside it: how
 * long since it was attempted, and what its last completed sweep actually spent.
 *
 * `observed_calls` is read off `runs.calls` for THIS route
 * by `route_id` — the `origin`/`destination` scalars are only the
 * route's primary airports, so two routes sharing a pair would otherwise be
 * priced off each other's measurements).
 */
export async function alertRouteRows(env: Env): Promise<AlertRouteRow[]> {
  return await selectAlertRoutes(env.DB);
}

/**
 * What each route costs a sweep, keyed by id.
 */
export function alertRouteCosts(
  rows: readonly AlertRouteRow[],
  today: string,
): Map<number, AlertRouteCost> {
  return new Map(
    rows.map((r) => [
      r.id,
      {
        routeId: r.id,
        chunks: planSeatsAeroChunks(r.date_start, r.date_end, today).length,
        groups: queryGroupCount(
          {
            origins: parseList(r.origins, r.origin),
            destinations: parseList(r.destinations, r.destination),
          },
          r.round_trip === 1,
          parseList(r.via),
        ),
        observedCalls: r.observed_calls == null ? undefined : Number(r.observed_calls),
      },
    ]),
  );
}

/** `SEA/PDX → NRT/HND` — the route's identity is its shape, which is what both
 *  surfaces that list routes already show. */
export function routeLabel(r: AlertRouteRow): string {
  const o = parseList(r.origins, r.origin).join("/");
  const d = parseList(r.destinations, r.destination).join("/");
  return `${o} ${r.round_trip === 1 ? "⇄" : "→"} ${d}`;
}
