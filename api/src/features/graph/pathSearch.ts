import {
  ABSOLUTE_SLACK_MI,
  MAX_DETOUR,
  haversineMi,
  rankPaths,
  type Coord,
} from "./paths.js";
import { graphPathRowsForPairs } from "../../db/routeGraph.js";
import { airportCoords } from "../../db/airports.js";
import { SEATSAERO_PROGRAM_MAP } from "../../providers/seatsaero.js";
import type { PathSearchResult } from "../../../../shared/src/wire/index.js";

/**
 * The escalation ladder over the route graph: how you would get there with a
 * stop, when nobody monitors the pair itself.
 *
 * Impure orchestration over D1 and the pure `rankPaths` — which is why it sits
 * here beside `run.ts` rather than in `domain/` (which is pure) or `db/` (which
 * is SQL). It was a private helper in `endpoints/seatsaeroRoutes.ts` with two
 * callers in that file; a tracked route filling in its own hubs on save is the
 * third, and a helper with three callers in two directories is a module. Same
 * argument that split `search/run.ts` from its HTTP shell.
 *
 * **It stops at the first depth that answers.** JFK->LHR is a monitored market
 * and never runs a self-join at all; SFO->KTM answers at one stop through seven
 * hubs; PIT->KTM has no one-stop option and needs two. Going deeper than the
 * shallowest answer would bury the good routing under hundreds of worse ones.
 *
 * Every path here is a D1 read. Nothing in this file spends a metered call.
 */

/** Pairs that get the two-stop query in one reach sweep. The one-stop pass is
 *  uncapped — it is 3 ms — but two stops is a three-way join per pair, and a
 *  user with many broken routes should not turn the panel into a scan. */
export const REACH_DEEP_PAIRS = 12;

/** seats.aero source key -> our `programs.code`, or null when this app stores no
 *  program for it. `SEATSAERO_PROGRAM_MAP` stays the one owner of that mapping. */
export const programOf = (source: string): string | null =>
  SEATSAERO_PROGRAM_MAP[source] ?? null;

export const pairKeyOf = (origin: string, destination: string): string =>
  `${origin}>${destination}`;

export interface GraphPathSearch {
  results: Map<string, PathSearchResult>;
  /** Pairs the deep-check limit left unsearched past one stop. They are still
   *  gaps, but "we stopped looking" is not "there is nothing there". */
  deepSkipped: Set<string>;
  deepChecked: number;
}

export async function searchGraphPaths(
  db: D1Database,
  pairs: readonly { origin: string; destination: string }[],
  opts: { fetched: ReadonlySet<string>; maxStops: 1 | 2; deepPairLimit?: number },
): Promise<GraphPathSearch> {
  const results = new Map<string, PathSearchResult>();
  const deepSkipped = new Set<string>();
  let deepChecked = 0;
  if (!pairs.length) return { results, deepSkipped, deepChecked };

  // Endpoints first, because the budget each pair earns comes from its own great
  // circle and has to be known before the join is asked for anything.
  const coords = await airportCoords(db, pairs.flatMap((p) => [p.origin, p.destination]));
  const coordOf = (code: string): Coord | null => coords.get(code) ?? null;

  const depths: (1 | 2)[] = opts.maxStops === 2 ? [1, 2] : [1];
  for (const stops of depths) {
    let remaining = pairs.filter((p) => !results.has(pairKeyOf(p.origin, p.destination)));
    if (!remaining.length) break;

    if (stops === 2 && opts.deepPairLimit !== undefined) {
      for (const p of remaining.slice(opts.deepPairLimit)) {
        deepSkipped.add(pairKeyOf(p.origin, p.destination));
      }
      remaining = remaining.slice(0, opts.deepPairLimit);
      deepChecked = remaining.length;
    }
    if (!remaining.length) break;

    const rows = await graphPathRowsForPairs(
      db,
      remaining.map((p) => ({
        origin: p.origin,
        destination: p.destination,
        budgetMi: budgetFor(p.origin, p.destination, coordOf, stops),
      })),
      // Two stops is one program's own network or nothing: three legs in three
      // programs is three award tickets, not an itinerary.
      { stops, sameSource: stops === 2 },
    );

    // A source whose last fetch failed still has rows from an earlier one. They
    // are not authoritative, so a leg flown only by such a source is dropped —
    // the same rule `/routes/pair` applies to a direct edge.
    const live = rows.filter((r) => r.legSources.every((s) => opts.fetched.has(s)));

    const hubs = await airportCoords(db, live.flatMap((r) => r.via));
    for (const [code, coord] of hubs) coords.set(code, coord);

    const byPair = new Map<string, typeof live>();
    for (const row of live) {
      const key = pairKeyOf(row.origin, row.destination);
      const list = byPair.get(key);
      if (list) list.push(row);
      else byPair.set(key, [row]);
    }

    for (const pair of remaining) {
      const key = pairKeyOf(pair.origin, pair.destination);
      const ranked = rankPaths(byPair.get(key) ?? [], {
        origin: pair.origin,
        destination: pair.destination,
        coords: coordOf,
        programOf,
        stops,
      });
      if (ranked.paths.length) {
        results.set(key, { depth: stops, paths: ranked.paths, truncated: ranked.truncated });
      }
    }
  }

  // Whatever is still unanswered was searched as deep as this call goes, and
  // says so by carrying the deepest depth tried with an empty list.
  const deepest = depths[depths.length - 1] ?? 1;
  for (const pair of pairs) {
    const key = pairKeyOf(pair.origin, pair.destination);
    if (!results.has(key)) results.set(key, { depth: deepest, paths: [], truncated: false });
  }
  return { results, deepSkipped, deepChecked };
}

/** What a path may span, in STORED miles, before the join stops returning it.
 *  Null when either end has no coordinates — no great circle, so no budget, and
 *  a guess would be worse than no bound at all. */
function budgetFor(
  origin: string,
  destination: string,
  coordOf: (code: string) => Coord | null,
  stops: 1 | 2,
): number | null {
  const a = coordOf(origin);
  const b = coordOf(destination);
  if (!a || !b) return null;
  const direct = haversineMi(a, b);
  return Math.round(Math.max(direct * MAX_DETOUR[stops], direct + ABSOLUTE_SLACK_MI));
}
