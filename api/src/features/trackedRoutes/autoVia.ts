import { MAX_VIA, searchPairs } from "../../domain/routing.js";
import { fetchedSources, graphRowsForPairs, readFetchRecords } from "../../db/routeGraph.js";
import { searchGraphPaths } from "../graph/pathSearch.js";

/**
 * The hubs a route should monitor, worked out from the route graph.
 *
 * Called only when the client sent no `via` at all, and only for a one-way
 * route. What it answers is "does anybody actually sell this pair" — and when
 * nobody does, which stops would fix it. A pair somebody monitors gets NO hubs:
 * the search already finds its connections, because seats.aero returns
 * connecting itineraries within a monitored market, and a second query would be
 * spent asking about a market the first one already covers.
 *
 * Costs nothing. Every read below is D1, over the graph the Tools page already
 * bought. Failure is silent and yields no hubs: a route must be creatable on a
 * day the route graph is empty, and "no hubs" is exactly what an unfetched graph
 * should conclude.
 */
export async function autoVia(
  db: D1Database,
  spec: { origins: string[]; destinations: string[] },
  roundTrip: boolean,
): Promise<string[]> {
  if (roundTrip) return [];
  try {
    const pairs = searchPairs(spec, false);
    if (!pairs.length) return [];

    const records = await readFetchRecords(db);
    const fetched = new Set(fetchedSources(records));
    if (!fetched.size) return [];

    // A pair anybody monitors needs no hubs — see above.
    const direct = await graphRowsForPairs(db, pairs);
    const flown = new Set(
      direct.filter((r) => fetched.has(r.source)).map((r) => `${r.origin}>${r.destination}`),
    );
    const gaps = pairs.filter((p) => !flown.has(`${p.origin}>${p.destination}`));
    if (!gaps.length) return [];

    const { results } = await searchGraphPaths(db, gaps, { fetched, maxStops: 2 });

    // Hubs in the order the paths were RANKED — shortest detour first — deduped
    // across a multi-airport route's several gap pairs, and capped. `planRoute`
    // caps again, because this is not the only way a `via` can arrive.
    const hubs: string[] = [];
    for (const pair of gaps) {
      const found = results.get(`${pair.origin}>${pair.destination}`);
      for (const path of found?.paths ?? []) {
        for (const hub of path.via) {
          if (!hubs.includes(hub)) hubs.push(hub);
          if (hubs.length >= MAX_VIA) return hubs;
        }
      }
    }
    return hubs;
  } catch {
    // A route that cannot be priced is still a route worth saving.
    return [];
  }
}
