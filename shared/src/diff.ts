import type { AvailabilityResult } from "./types.js";
import { routeKey } from "./types.js";
import type { ChangeSummary, ChangeType } from "./wire/domain.js";

// `ChangeType` and `ChangeSummary` are declared in `./wire/domain.ts` — the SPA
// renders both, so the wire contract owns them and this module re-exports them.
// `diffAvailability` below, which produces them, is Worker-only.
export type { ChangeSummary, ChangeType } from "./wire/domain.js";

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
