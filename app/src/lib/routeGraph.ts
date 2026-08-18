import type { RouteGraphEdge } from "../api";

/**
 * Turning a program's route graph into something drawable.
 *
 * Pure, and in `lib/` because that is where a thing goes when it wants a test —
 * vitest collects `*.test.ts` only, so this could not live in the map component
 * and still be covered.
 */

/** A drawable arc: both ends resolved to real coordinates. */
export interface GraphLine {
  origin: string;
  destination: string;
  from: [number, number];
  to: [number, number];
  /** True when the graph holds this pair in both directions. */
  bidirectional: boolean;
}

export interface GraphLines {
  lines: GraphLine[];
  /**
   * Distinct CITY PAIRS the edge list held, drawn or not.
   *
   * Not the same number as the edge count, and the difference is the whole
   * reason this is reported: a pair flown both ways is two directed edges and
   * one line. Captioning "2,500 of 8,130 drawn" against the edge count while
   * counting merged pairs as drawn produces arithmetic that does not add up.
   */
  pairs: number;
  /** Edges dropped because an endpoint is not in the `airports` table, or is
   *  there without coordinates. Reported rather than silently missing: a route
   *  graph drawn short reads as a program that flies fewer places. */
  unplottable: number;
  /** Edges beyond `max`, not drawn. */
  omitted: number;
}

/**
 * Collapse a directed edge list into drawable arcs.
 *
 * Two things happen here and both are visible in the output rather than
 * implied. A pair flown both ways is ONE line — drawing SFO→NRT and NRT→SFO as
 * two overlapping arcs doubles the ink for no information. And the list is
 * capped, because thousands of SVG paths crawl; what is dropped is counted so
 * the caption can say so.
 */
export function graphLines(
  edges: readonly RouteGraphEdge[],
  max: number,
): GraphLines {
  const seen = new Map<string, GraphLine>();
  // Pairs beyond the cap are still counted, so the caption can say how many
  // exist rather than only how many fit.
  const overflow = new Set<string>();
  let unplottable = 0;
  let omitted = 0;

  for (const e of edges) {
    const from = coords(e.origin_lat, e.origin_lon);
    const to = coords(e.destination_lat, e.destination_lon);
    if (!from || !to) {
      unplottable++;
      continue;
    }

    // One key per unordered pair, so the reverse edge lands on the same entry.
    const [a, b] = e.origin < e.destination ? [e.origin, e.destination] : [e.destination, e.origin];
    const key = `${a}>${b}`;
    const existing = seen.get(key);
    if (existing) {
      existing.bidirectional = true;
      continue;
    }
    if (seen.size >= max) {
      // Count the PAIR once, not each of its directions.
      if (!overflow.has(key)) {
        overflow.add(key);
        omitted++;
      }
      continue;
    }
    seen.set(key, {
      origin: e.origin,
      destination: e.destination,
      from,
      to,
      bidirectional: false,
    });
  }

  return { lines: [...seen.values()], pairs: seen.size + overflow.size, unplottable, omitted };
}

function coords(lat: number | null, lon: number | null): [number, number] | null {
  if (lat === null || lon === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // OurAirports has a handful of rows at exactly 0,0 that are placeholders
  // rather than a real point in the Gulf of Guinea. Dropped for the same reason
  // a null is: better absent than wrong.
  if (lat === 0 && lon === 0) return null;
  return [lat, lon];
}

/**
 * Bounds that fit every drawn arc, as Leaflet wants them.
 *
 * Null when there is nothing to fit, which the caller reads as "leave the view
 * alone" rather than "zoom to nowhere".
 */
export function graphBounds(lines: readonly GraphLine[]): [[number, number], [number, number]] | null {
  if (!lines.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const l of lines) {
    for (const [lat, lon] of [l.from, l.to]) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

/** The distinct airports the drawn arcs touch, for the endpoint dots. */
export function graphEndpoints(lines: readonly GraphLine[]): { code: string; at: [number, number] }[] {
  const out = new Map<string, [number, number]>();
  for (const l of lines) {
    if (!out.has(l.origin)) out.set(l.origin, l.from);
    if (!out.has(l.destination)) out.set(l.destination, l.to);
  }
  return [...out].map(([code, at]) => ({ code, at }));
}
