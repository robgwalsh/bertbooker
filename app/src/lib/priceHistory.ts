import type { PricePoint } from "../api";

// The arithmetic behind the price chart, kept out of the component so
// `*.test.ts` can reach it — the same split `routeMapGeometry.ts` makes for
// `RouteMap.tsx`, and for the same reason: `vitest.config.ts` globs `*.test.ts`
// only, so logic that lives in a `.tsx` is silently never covered.
//
// Two properties of the stored series shape everything here.
//
// **It is written ON CHANGE, not per search.** Two points a week apart do not
// mean nobody looked; they mean the price held. So the line is a STEP function
// and must never be interpolated between observations — a diagonal would draw a
// gradual drift that never happened.
//
// **A gone point is a real observation, not a gap.** `miles === null` records a
// source covering the slot and reporting nothing. Drawing it as zero claims a
// free seat; drawing through it claims the award never went away. It breaks the
// line, which is why `segments` is plural.

/** One observation, in the units the chart works in. */
export interface SeriesPoint {
  /** `captured_at` — when WE saw this, which is the only clock a gone point has. */
  at: number;
  /** Null = the source covered this slot and reported no offer. */
  miles: number | null;
  seats: number | null;
}

/** Oldest first, one entry per timestamp. */
export function priceSeries(points: readonly PricePoint[]): SeriesPoint[] {
  const byTime = new Map<number, SeriesPoint>();
  for (const p of points) {
    // Last writer wins: two rows sharing a `captured_at` are one batch's view of
    // the slot, and the later one in the payload is the later one written.
    byTime.set(p.captured_at, {
      at: p.captured_at,
      miles: p.miles_cost,
      seats: p.seats_available,
    });
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

/**
 * Carry the last observation forward to `now`.
 *
 * Without this the line stops at whenever the price last MOVED, which on a
 * stable award reads as data that went missing. A gone point holds forward too —
 * it stays null, so the line stays broken, which is the honest picture of an
 * award that is still absent.
 */
export function holdToNow(series: readonly SeriesPoint[], now: number): SeriesPoint[] {
  const last = series.at(-1);
  if (!last || last.at >= now) return [...series];
  return [...series, { at: now, miles: last.miles, seats: last.seats }];
}

export interface Sparkline {
  /** SVG path `d` strings, one per unbroken run. Empty when nothing is drawable. */
  segments: string[];
  /** The price axis actually drawn, ignoring gone points. */
  min: number;
  max: number;
  /** The most recent known price, or null if the slot is currently gone. */
  last: number | null;
}

/**
 * Project a series onto a box.
 *
 * `H`/`V` rather than `L`: the value held until the next observation, so the
 * path steps across and then down. y is inverted because SVG's origin is the
 * top-left and a cheaper award should sit lower.
 *
 * A run of ONE point emits a zero-length line, which with `stroke-linecap:
 * round` renders as a dot — a single observation is a real thing to show, and an
 * empty path would silently drop it.
 */
export function sparkline(
  series: readonly SeriesPoint[],
  width: number,
  height: number,
): Sparkline {
  const priced = series.filter((p) => p.miles != null);
  if (priced.length === 0) return { segments: [], min: 0, max: 0, last: null };

  const values = priced.map((p) => p.miles!);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const t0 = series[0]!.at;
  const t1 = series.at(-1)!.at;
  const span = t1 - t0;
  // A series with one distinct timestamp has no time axis to spread over; pin it
  // to the left rather than dividing by zero.
  const x = (at: number) => (span > 0 ? ((at - t0) / span) * width : 0);
  // A flat series has no price axis either. Centre it: drawing it at the top or
  // the bottom would imply a comparison the data does not support.
  const y = (m: number) => (max > min ? height - ((m - min) / (max - min)) * height : height / 2);

  const segments: string[] = [];
  let run: SeriesPoint[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const head = run[0]!;
    let d = `M ${x(head.at)} ${y(head.miles!)}`;
    if (run.length === 1) d += ` L ${x(head.at)} ${y(head.miles!)}`;
    for (const p of run.slice(1)) d += ` H ${x(p.at)} V ${y(p.miles!)}`;
    segments.push(d);
    run = [];
  };
  for (const p of series) {
    if (p.miles == null) flush();
    else run.push(p);
  }
  flush();

  return { segments, min, max, last: series.at(-1)?.miles ?? null };
}

export interface BestComparison {
  isBest: boolean;
  /** How much dearer than the cheapest ever seen, as a whole percent. */
  pctAbove: number;
}

/**
 * This price against the cheapest ever recorded for the slot.
 *
 * Null when there is nothing to compare against — a slot first seen after the
 * history table existed has no record, and "no cheapest known" must not render
 * as "this is the cheapest".
 *
 * `isBest` is `<=` rather than `===` because the history is written from the
 * same rows the find is: the current price is normally IN it, and a find written
 * between a search and its history point would otherwise read as dearer than a
 * record that does not yet include it.
 */
export function vsBest(current: number, best?: number | null): BestComparison | null {
  if (best == null || best <= 0) return null;
  if (current <= best) return { isBest: true, pctAbove: 0 };
  return { isBest: false, pctAbove: Math.round(((current - best) / best) * 100) };
}
