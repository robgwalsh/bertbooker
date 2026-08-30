import type { GraphPath, PathLeg } from "../../../../shared/src/wire/index.js";

/**
 * Getting from A to B THROUGH the route graph, when nobody monitors A->B itself.
 *
 * `graphReach.ts` asks whether one edge is in anybody's network. This asks the
 * question that matters once the answer is no: SFO->KTM is in no program's
 * graph, and is reachable via seven hubs. Reading the graph as a set of isolated
 * edges made every long-haul that lacks a nonstop market look impossible, which
 * is most of the interesting ones.
 *
 * **A path is not an itinerary, and this module cannot promise a seat.** It is a
 * claim about which markets seats.aero monitors, chained. The legs are the
 * searchable objects — seats.aero holds availability per monitored market, and
 * the asked pair is not one — so what a caller does with a path is track its
 * legs, never search the pair again.
 *
 * Pure, and offline-testable. Nothing here knows about D1, the Worker, or fetch.
 * The SQL that produces `PathCandidate`s pre-filters on the stored
 * `distance_mi`, which is a cheap bound and NOT the authority: 350 of 41,780
 * measured rows carry a zero distance, and the migration is explicit that zero
 * "means nothing useful". Every distance below is computed from coordinates.
 */

/** Earth's mean radius in statute miles — the unit `seatsaero_routes.distance_mi`
 *  is in, so the two are comparable without a conversion nobody would remember. */
const EARTH_RADIUS_MI = 3958.7613;

const DEG = Math.PI / 180;

export interface Coord {
  lat: number;
  lon: number;
}

/**
 * Great-circle distance in statute miles.
 *
 * Exported for its test rather than for a caller: it is the one piece of this
 * module with an answer that can be checked against the world.
 */
export function haversineMi(a: Coord, b: Coord): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One row of the self-join: a hub sequence, and the source flying each leg.
 *
 * `legSources[i]` is the source flying the leg from `nodes[i]` to `nodes[i+1]`,
 * so its length is always `via.length + 1`. A row where every entry is the same
 * source is a one-program path; the one-stop query does not restrict them to be,
 * because the mixed tier costs nothing to collect once the join has run.
 */
export interface PathCandidate {
  via: string[];
  legSources: string[];
}

export interface RankPathsOptions {
  origin: string;
  destination: string;
  /** Coordinates for a node, or null when the `airports` table has none. One
   *  airport in the whole measured graph is missing, so this is nearly total. */
  coords: (code: string) => Coord | null;
  /** seats.aero source key -> our `programs.code`, or null when unmapped. */
  programOf: (source: string) => string | null;
  stops: 1 | 2;
  maxPaths?: number;
}

/**
 * How far off a straight line a path may wander, by depth.
 *
 * Measured rather than guessed. SFO->KTM's great circle is ~7,600 mi and its
 * real one-stop options run 8,118 mi (ICN) to 10,647 mi (SIN, via Singapore
 * Airlines) — a genuine 1.40. A cap at 1.4 would have cut the last real answer,
 * so one stop sits at 1.5. Two stops is allowed more because two stops IS more,
 * not because the answers are better.
 */
export const MAX_DETOUR: Record<1 | 2, number> = { 1: 1.5, 2: 1.7 };

/**
 * Absolute slack, so a short pair is not judged by ratio alone.
 *
 * A 300-mile pair reached through a hub 500 miles away is a ratio of 4 and a
 * perfectly ordinary connection. The budget is the LARGER of the two rules, so
 * the ratio governs long haul and this governs short.
 */
export const ABSOLUTE_SLACK_MI = 800;

/** Paths returned per direction. Beyond this the list stops being an answer. */
export const MAX_PATHS = 25;

export interface RankedPaths {
  paths: GraphPath[];
  /** Paths the cap dropped. Stated, never silent — a short list otherwise reads
   *  as a short answer, which is the same lie `RouteGraphGeo.truncated` avoids. */
  truncated: boolean;
}

/**
 * Candidates in, ranked paths out.
 *
 * One-program paths sort ahead of mixed ones regardless of distance, because the
 * difference between them is one award and two, not a few hundred miles.
 */
export function rankPaths(
  candidates: readonly PathCandidate[],
  opts: RankPathsOptions,
): RankedPaths {
  const { origin, destination, coords, programOf, stops } = opts;
  const maxPaths = opts.maxPaths ?? MAX_PATHS;

  const direct = distanceBetween(origin, destination, coords);
  // No coordinates for one end means no budget can be computed. Everything is
  // kept in that case: an unjudgeable path is not a bad one, and dropping it
  // would be inventing a verdict the data does not support.
  const budget =
    direct === null ? null : Math.max(direct * MAX_DETOUR[stops], direct + ABSOLUTE_SLACK_MI);

  // via sequence -> the sources seen on each leg of it.
  const grouped = new Map<string, Set<string>[]>();
  for (const candidate of candidates) {
    if (!isUsableVia(candidate, origin, destination)) continue;
    const key = candidate.via.join(">");
    let legs = grouped.get(key);
    if (!legs) {
      legs = candidate.via.map(() => new Set<string>());
      legs.push(new Set<string>());
      grouped.set(key, legs);
    }
    // A malformed row (fewer sources than legs) would silently under-populate a
    // leg and make the path look one-program. Skip it instead.
    if (candidate.legSources.length !== legs.length) continue;
    candidate.legSources.forEach((source, i) => legs[i]!.add(source));
  }

  const built: GraphPath[] = [];
  for (const [key, legSourceSets] of grouped) {
    const via = key ? key.split(">") : [];
    const nodes = [origin, ...via, destination];

    const legs: PathLeg[] = legSourceSets.map((sources, i) => {
      const from = nodes[i]!;
      const to = nodes[i + 1]!;
      const list = [...sources].sort();
      return {
        origin: from,
        destination: to,
        distanceMi: distanceBetween(from, to, coords),
        sources: list,
        programs: uniqueSorted(list.map(programOf).filter(isString)),
      };
    });

    // A partial sum presented as a total would understate the detour and let a
    // path through the budget it should have failed, so an unknown leg makes the
    // whole total unknown.
    const totalMi = legs.some((l) => l.distanceMi === null)
      ? null
      : Math.round(legs.reduce((sum, l) => sum + (l.distanceMi ?? 0), 0));
    if (budget !== null && totalMi !== null && totalMi > budget) continue;

    const programs = intersect(legs.map((l) => l.programs));
    const unmappedSources = intersect(
      legSourceSets.map((sources) => [...sources].filter((s) => programOf(s) === null)),
    );

    built.push({
      legs,
      via,
      totalMi,
      detour: direct && totalMi !== null ? Number((totalMi / direct).toFixed(3)) : null,
      programs,
      unmappedSources,
      mixed: programs.length === 0 && unmappedSources.length === 0,
    });
  }

  built.sort((a, b) => {
    if (a.mixed !== b.mixed) return a.mixed ? 1 : -1;
    // An unknown total sorts last rather than first: `null` beating every real
    // distance would put the least-known path at the top of the list.
    if (a.totalMi === null || b.totalMi === null) {
      if (a.totalMi === b.totalMi) return a.via.join(">").localeCompare(b.via.join(">"));
      return a.totalMi === null ? 1 : -1;
    }
    if (a.totalMi !== b.totalMi) return a.totalMi - b.totalMi;
    return a.via.join(">").localeCompare(b.via.join(">"));
  });

  return { paths: built.slice(0, maxPaths), truncated: built.length > maxPaths };
}

/**
 * A hub sequence that would not be a connection.
 *
 * The SQL excludes these too, and this is not redundant: the bulk query answers
 * many pairs at once, so a hub that is fine for one asked pair can be one of the
 * endpoints of another.
 */
function isUsableVia(candidate: PathCandidate, origin: string, destination: string): boolean {
  const { via } = candidate;
  if (!via.length) return false;
  if (new Set(via).size !== via.length) return false;
  return !via.some((hub) => hub === origin || hub === destination);
}

function distanceBetween(
  from: string,
  to: string,
  coords: (code: string) => Coord | null,
): number | null {
  const a = coords(from);
  const b = coords(to);
  if (!a || !b) return null;
  return Math.round(haversineMi(a, b));
}

/** Present in EVERY list — what "covers the whole path" means. An empty input
 *  intersects to nothing, which is the honest answer for a path with no legs. */
function intersect(lists: readonly string[][]): string[] {
  if (!lists.length) return [];
  const [first, ...rest] = lists as [string[], ...string[][]];
  return uniqueSorted(first.filter((value) => rest.every((list) => list.includes(value))));
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

const isString = (v: string | null): v is string => v !== null;
