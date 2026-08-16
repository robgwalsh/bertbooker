import type { AvailabilityResult } from "./types.js";
import { routeKey } from "./types.js";

export type ChangeType = "new" | "more_seats" | "price_drop" | "gone";

export interface AvailabilityChange {
  type: ChangeType;
  /** The current result (absent for "gone"). */
  current?: AvailabilityResult;
  /** The prior result (absent for "new"). */
  previous?: AvailabilityResult;
  /** Stable identity of the route+program+cabin+date this change concerns. */
  key: string;
}

/** Identity for comparing "the same seat" across snapshots. */
export function changeKey(r: Pick<AvailabilityResult, "origin" | "destination" | "flightDate" | "program" | "cabin">): string {
  return `${routeKey(r.origin, r.destination, r.flightDate)}|${r.program}|${r.cabin}`;
}

/** A change flattened for the wire — enough to render a row without shipping
 *  two whole `AvailabilityResult`s per change. Pure projection. */
export interface ChangeSummary {
  type: ChangeType;
  key: string;
  flightDate: string;
  program: string;
  cabin: string;
  /** The city pair. Recoverable from `key` only by knowing the flight date is
   *  its last ten characters — parseable, fragile, and the alert digest needs
   *  one line per change to say where the seat is. Optional because
   *  `search_runs.changes_json` holds blobs written before these existed, and
   *  because the SPA mirrors this type by hand (`web/src/api.ts`).
   *
   *  Note what these are NOT for: alert FILTERING does not read them. That
   *  question — "would this route's own pane show this find?" — is answered by
   *  intersecting with the finds query, so the route's cabin/currency/nonstop
   *  rules keep exactly one implementation. See `packages/core/src/alerts`. */
  origin?: string;
  destination?: string;
  /** Absent for "gone" (there is no current result). */
  milesCost?: number;
  seatsAvailable?: number;
  /** Absent for "new" (there is no prior result). */
  previousMilesCost?: number;
  previousSeats?: number;
}

export function summarizeChange(c: AvailabilityChange): ChangeSummary {
  const r = c.current ?? c.previous!;
  return {
    type: c.type,
    key: c.key,
    flightDate: r.flightDate,
    program: r.program,
    cabin: r.cabin,
    origin: r.origin,
    destination: r.destination,
    milesCost: c.current?.milesCost,
    seatsAvailable: c.current?.seatsAvailable,
    previousMilesCost: c.previous?.milesCost,
    previousSeats: c.previous?.seatsAvailable,
  };
}

/**
 * Compare a fresh set of results against the most recent prior snapshot for a
 * route and classify what changed. Only meaningful, alert-worthy transitions
 * are emitted:
 *   - "new"        award space that wasn't there before
 *   - "more_seats" seat count increased
 *   - "price_drop" miles cost decreased
 *   - "gone"       previously-available space disappeared
 */
export function diffAvailability(
  previous: AvailabilityResult[],
  current: AvailabilityResult[],
): AvailabilityChange[] {
  const prevByKey = new Map(previous.map((r) => [changeKey(r), r] as const));
  const currByKey = new Map(current.map((r) => [changeKey(r), r] as const));
  const changes: AvailabilityChange[] = [];

  for (const [key, cur] of currByKey) {
    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({ type: "new", current: cur, key });
    } else if (cur.seatsAvailable > prev.seatsAvailable) {
      changes.push({ type: "more_seats", current: cur, previous: prev, key });
    } else if (cur.milesCost < prev.milesCost) {
      changes.push({ type: "price_drop", current: cur, previous: prev, key });
    }
  }

  for (const [key, prev] of prevByKey) {
    if (!currByKey.has(key)) {
      changes.push({ type: "gone", previous: prev, key });
    }
  }

  return changes;
}
