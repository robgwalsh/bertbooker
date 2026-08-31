import type { Collapsible } from "../models/offer.js";

/**
 * WHICH OF TWO OFFERS IS BETTER — a decision about award value, and the fields
 * it reads (`Collapsible`, `api/src/models/offer.ts`).
 *
 * Lives here, not in `features/search/`, because its two callers are
 * `providers/seatsaero.ts` (collapsing a payload's own trips) and
 * `features/search/apply.ts` (collapsing a task's offers before writing them) —
 * `providers/` only ever imports downward from `models/`, so putting a rule
 * `providers/seatsaero.ts` needs into `features/` would have `providers/`
 * reach upward into it, the one edge nothing else in the tree has. `apply.ts`
 * importing this from `providers/` is the direction that's already normal:
 * `features/search/run.ts` already imports several functions straight out of
 * `providers/seatsaero.js`.
 *
 * "Cheapest miles, then more seats, then fewer stops, then shorter" is an
 * opinion about award travel, not a sort helper, and it is load-bearing rather
 * than cosmetic — see `collapseBy`.
 */

/** Cheapest miles wins; ties break on more seats, then fewer stops, then
 *  shorter. Pure and total. */
export function betterOffer<T extends Collapsible>(a: T, b: T): boolean {
  if (a.milesCost !== b.milesCost) return a.milesCost < b.milesCost;
  if (a.seatsAvailable !== b.seatsAvailable) return a.seatsAvailable > b.seatsAvailable;
  const aStops = a.stops ?? (a.segments.length ? a.segments.length - 1 : 9);
  const bStops = b.stops ?? (b.segments.length ? b.segments.length - 1 : 9);
  if (aStops !== bStops) return aStops < bStops;
  return (a.durationMinutes ?? Infinity) < (b.durationMinutes ?? Infinity);
}

/**
 * Keep the single best item per key.
 *
 * REQUIRED, not an optimization, wherever the result feeds a snapshot: the
 * `finds` row and `changeKey` are keyed (route, date, program,
 * cabin), so two itineraries competing for one slot would collide
 * non-deterministically and the diff would flap between them, reporting phantom
 * price_drop/more_seats changes on every run.
 *
 * Callers pick the key: an airline adapter knows its program already and keys on
 * (date, cabin); ingest sees many programs at once and keys on
 * (date, program, cabin). Pure.
 */
export function collapseBy<T extends Collapsible>(items: T[], key: (item: T) => string): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const cur = best.get(k);
    if (!cur || betterOffer(item, cur)) best.set(k, item);
  }
  return [...best.values()];
}
