import { SEATSAERO_SOURCE_ID } from "../../providers/seatsaero.js";
import { selectBudgetRows } from "../../db/sourceQuota.js";

/**
 * The budget guard — scoped to the scheduler alone.
 */

/** `X-RateLimit-Limit` is usually present, but the guard must work on a day
 *  nothing has observed one. A Pro key buys 1000 per UTC day. */
export const ASSUMED_DAILY_LIMIT = 1000;

/** The `settings` row holding the scheduler's share of the day, 0–100. */
export const ALERT_ALLOWANCE_KEY = "alert_allowance_pct";
export const DEFAULT_ALERT_ALLOWANCE_PCT = 80;

/** 0–100, and a whole number: the slider that sets it steps by one, and a
 *  fractional share of a thousand calls is not a decision anyone makes. */
export const clampAllowancePct = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(Math.max(Math.round(v), 0), 100)
    : fallback;

/**
 * One knob, two numbers. The percentage is the scheduler's share of the day's
 * limit; whatever it leaves is the reserve a manual Search draws on. Rounded
 * down so the two always sum to the limit and the budget never overstates.
 */
export function alertAllowance(pct: number, limit: number): { dailyBudget: number; reserve: number } {
  const dailyBudget = Math.floor((limit * pct) / 100);
  return { dailyBudget, reserve: limit - dailyBudget };
}

export interface QuotaObservation {
  remaining: number;
  limitCalls: number | null;
  observedAt: number;
}

export type SweepDecision =
  | { go: true; projectedRemaining: number; basis: "observed" | "self_accounted" }
  | { go: false; reason: "reserve" | "exhausted"; projectedRemaining: number; basis: "observed" | "self_accounted" };

/**
 * May the scheduler spend `estimatedCost` calls right now?
 *
 * Pure, so the whole of the interesting reasoning is testable without a D1.
 */
export function decideSweep(args: {
  /** Today's observation, if one exists for the CURRENT UTC day. */
  observation?: QuotaObservation;
  /** Sum of `runs.calls` for runs started today (UTC). */
  selfSpentToday: number;
  estimatedCost: number;
  reserve: number;
  dailyBudget: number;
}): SweepDecision {
  const basis: "observed" | "self_accounted" = args.observation ? "observed" : "self_accounted";
  const limit = args.observation?.limitCalls ?? ASSUMED_DAILY_LIMIT;
  const remaining = args.observation
    ? args.observation.remaining
    : Math.max(0, limit - args.selfSpentToday);

  const projectedRemaining = remaining - args.estimatedCost;

  if (remaining <= 0) return { go: false, reason: "exhausted", projectedRemaining, basis };
  // The reserve is the whole point: stop short of the ceiling so a human still
  // has room. Note this compares against what would be left AFTER the sweep.
  if (projectedRemaining < args.reserve) {
    return { go: false, reason: "reserve", projectedRemaining, basis };
  }
  // The scheduler's own daily allowance, separate from the reserve: it bounds
  // what automation may spend even on a day the reserve is nowhere near.
  if (args.selfSpentToday + args.estimatedCost > args.dailyBudget) {
    return { go: false, reason: "reserve", projectedRemaining, basis };
  }
  return { go: true, projectedRemaining, basis };
}

/** The UTC day `source_quota` is keyed by — the day the allowance resets. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Midnight UTC of `now`'s day, in ms — the window `selfSpentToday` sums over. */
export function utcDayStart(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00.000Z`);
}

/**
 * Read what the guard needs out of D1.
 */
export async function readBudgetState(
  db: D1Database,
  now: number,
): Promise<{ observation?: QuotaObservation; selfSpentToday: number }> {
  const { quota, spent } = await selectBudgetRows(
    db,
    SEATSAERO_SOURCE_ID,
    utcDay(now),
    utcDayStart(now),
  );

  return {
    observation: quota
      ? {
          remaining: Number(quota.remaining),
          limitCalls: quota.limit_calls == null ? null : Number(quota.limit_calls),
          observedAt: Number(quota.observed_at),
        }
      : undefined,
    selfSpentToday: Number(spent),
  };
}
