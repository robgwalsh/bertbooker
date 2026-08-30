import type { AvailabilityResult } from "./availability.js";

/**
 * WHICH OF TWO OFFERS IS BETTER — a decision about award value, and the fields
 * it reads.
 *
 * A model rather than a util: "cheapest miles, then more seats, then fewer
 * stops, then shorter" is an opinion about award travel, not a sort helper. It
 * is also load-bearing rather than cosmetic — see `collapseBy`.
 */

/**
 * The subset of fields the rule reads.
 * Both `AirlineOffer` (carrier-shaped, pre-normalization) and
 * `AvailabilityResult` (normalized) satisfy it, which is the point: the rule is
 * a domain decision about award value, not a detail of either shape.
 */
export type Collapsible = Pick<
  AvailabilityResult,
  "flightDate" | "cabin" | "milesCost" | "seatsAvailable" | "segments"
> &
  Partial<Pick<AvailabilityResult, "stops" | "durationMinutes">>;

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
