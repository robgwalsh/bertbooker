import { searchPairs } from "../routing/plan.js";
import type { GraphPair } from "../../models/routeGraph.js";
import type {
  GraphPath,
  PairReach,
  ReachReport,
  ReachVerdict,
  RouteReach,
} from "../../models/wire/index.js";

/** Hub sequences reported per pair. The panel NAMES the hubs; it does not plan
 *  the trip, and the pair lookup is where a full list belongs. */
export const REACH_PATHS_PER_PAIR = 3;

/**
 * Does anyone's route graph contain the pairs a tracked route asks about?
 *
 * **This is not "coverage", and the word is avoided on purpose.** Coverage
 * already means *did we look at (route, date, program)* — a fact about our own
 * searching, and the thing that licenses a prune. This is a fact about the
 * SOURCE'S OWN NETWORK: true or false before anyone searches anything, and it
 * can never license a prune. Merging the two vocabularies would be the
 * beginning of merging the two facts.
 *
 * What it is good for: a tracked pair that is in no program's graph will come
 * back empty from every search, forever, and nothing else in the app says so.
 * That is a route worth editing rather than a route worth re-searching.
 *
 * Pure, and offline-testable. The pair expansion is `searchPairs` — the SAME
 * function the search itself plans with, deliberately. A second implementation
 * would eventually report on a pair the search never asks about.
 */
export function assessGraphReach(opts: GraphReachInput): ReachReport {
  const { routes, graph, fetched, programOf, totalSources } = opts;
  const paths = opts.paths ?? new Map<string, GraphPath[]>();
  const deepSkipped = opts.deepSkipped ?? new Set<string>();
  const fetchedSet = new Set(fetched);
  // (origin destination) -> the sources flying it, restricted to fetched ones.
  // A source's rows can outlive its fetch record's authority — a `failed`
  // re-fetch leaves the previous graph in place — so the set, not the table, is
  // what decides who counts.
  const byPair = new Map<string, string[]>();
  for (const row of graph) {
    if (!fetchedSet.has(row.source)) continue;
    const key = pairKey(row.origin, row.destination);
    const list = byPair.get(key);
    if (list) list.push(row.source);
    else byPair.set(key, [row.source]);
  }

  const anythingFetched = fetchedSet.size > 0;

  const assessed: RouteReach[] = routes.map((route) => {
    const pairs = expandPairs(route);
    const allowed = route.programs?.length ? new Set(route.programs) : null;

    const pairReach: PairReach[] = pairs.map(({ origin, destination }) => {
      const sources = byPair.get(pairKey(origin, destination)) ?? [];
      const programs: string[] = [];
      const unmappedSources: string[] = [];

      for (const source of sources) {
        const program = programOf(source);
        if (program === null) {
          unmappedSources.push(source);
          continue;
        }
        // Honour the route's own program filter. Without this a route could
        // read as reachable through a program it deliberately excludes.
        if (allowed && !allowed.has(program)) continue;
        if (!programs.includes(program)) programs.push(program);
      }

      // A path through a program this route excludes is not a path this route
      // can use, exactly as a direct edge through one is not reach.
      const viaPaths = (paths.get(pairKey(origin, destination)) ?? [])
        .filter((path) => !allowed || path.programs.some((p) => allowed.has(p)))
        .slice(0, REACH_PATHS_PER_PAIR);

      const verdict: ReachVerdict = !anythingFetched
        ? "unknown"
        : programs.length || unmappedSources.length
          ? "ok"
          : viaPaths.length
            ? "indirect"
            : "gap";

      return {
        origin,
        destination,
        verdict,
        programs: programs.sort(),
        unmappedSources: unmappedSources.sort(),
        paths: verdict === "indirect" ? viaPaths : [],
        // Only meaningful on a `gap`: it is the difference between "we looked
        // as deep as we look and found nothing" and "we stopped looking".
        deepCheckSkipped: verdict === "gap" && deepSkipped.has(pairKey(origin, destination)),
      };
    });

    return {
      routeId: route.id,
      origin: route.origin,
      destination: route.destination,
      roundTrip: route.roundTrip,
      verdict: worst(pairReach),
      pairs: pairReach,
    };
  });

  return {
    fetchedSources: fetchedSet.size,
    totalSources,
    routes: assessed,
    deepCheckedPairs: opts.deepCheckedPairs ?? 0,
    deepPairLimit: opts.deepPairLimit ?? 0,
  };
}

export interface GraphReachInput {
  routes: readonly ReachRouteInput[];
  /** Every (pair, source) row for the union of the routes' pairs. */
  graph: readonly GraphPair[];
  /** Sources whose stored graph may be reasoned about — see `fetchedSources`
   *  in `db/routeGraph.ts`. A `failed` source is NOT one of them. */
  fetched: readonly string[];
  /** seats.aero source key -> our `programs.code`, or null when unmapped. */
  programOf: (source: string) => string | null;
  /** How many sources exist at all, so a `gap` can be qualified honestly:
   *  "no fetched program flies this (6 of 26 fetched)". */
  totalSources: number;
  /**
   * Hub sequences reaching a pair nobody flies directly, by `origin>destination`.
   *
   * Optional, and absent means "nobody looked" rather than "nothing is there" —
   * which is why the caller runs this function TWICE: once with no paths to find
   * out which pairs are gaps, then again once those gaps have been searched.
   * Deciding gap-ness in two places instead would be two rules to keep in step.
   */
  paths?: ReadonlyMap<string, GraphPath[]>;
  /** Pairs the deep-check budget did not reach. They stay `gap`, but say so. */
  deepSkipped?: ReadonlySet<string>;
  deepCheckedPairs?: number;
  deepPairLimit?: number;
}

/** A tracked route, reduced to what this question needs. */
export interface ReachRouteInput {
  id: number;
  origin: string;
  destination: string;
  origins: string[] | null;
  destinations: string[] | null;
  roundTrip: boolean;
  /** The route's own program filter, or null for "no filter". */
  programs: string[] | null;
}

/**
 * A route's verdict is its WORST pair's.
 *
 * SEA/PDX -> NRT/HND is four independent pairs. If one of them is in nobody's
 * graph, the route has a named hole, and calling it "ok" because three quarters
 * of it is fine would hide exactly the thing worth acting on. The rest of the
 * system already treats a route this way — a coverage claim names both
 * endpoints and pruning is per pair.
 *
 * `indirect` sits between `gap` and `ok` because it is genuinely between them:
 * the network reaches the pair, and a search of the route as written still
 * returns nothing. Ranking it as `ok` would hide work the user has to do.
 */
function worst(pairs: readonly PairReach[]): ReachVerdict {
  if (!pairs.length) return "unknown";
  if (pairs.some((p) => p.verdict === "unknown")) return "unknown";
  if (pairs.some((p) => p.verdict === "gap")) return "gap";
  return pairs.some((p) => p.verdict === "indirect") ? "indirect" : "ok";
}

function expandPairs(route: ReachRouteInput): { origin: string; destination: string }[] {
  try {
    return searchPairs(
      {
        origins: route.origins?.length ? route.origins : [route.origin],
        destinations: route.destinations?.length ? route.destinations : [route.destination],
      },
      route.roundTrip,
    );
  } catch {
    // A spec `normalizeSpec` refuses is a route that should never have been
    // saved. This surface reports on routes; it does not police them, and one
    // bad row must not take the whole panel down.
    return [];
  }
}

const pairKey = (origin: string, destination: string): string => `${origin}>${destination}`;
