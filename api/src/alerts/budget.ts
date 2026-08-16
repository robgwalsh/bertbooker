import { SEATSAERO_SOURCE_ID } from "../../../shared/src/index.js";

/**
 * The budget guard — reinstated, and scoped to the scheduler alone.
 *
 * **This file is the exception that three comments elsewhere warn about**, and
 * it lives on its own so that "who consults quota before spending" stays a
 * one-file answer to `grep`. `migrations/0001_init.sql` says of `source_quota`:
 * "if you ever find code gating a call on this value, that is the guard coming
 * back and it needs the argument in CLAUDE.md to survive first." Here is the
 * argument, in short; `docs/ALERTS.md` is the long form.
 *
 * The guard was deleted because *unattended work* was deleted. A person pressing
 * Search does not need protecting from a call they chose to spend, and a guard
 * in that path turns a deliberate action into a baffling refusal. Both halves
 * are still true, and `search.ts` and `enrich.ts` still spend first and report
 * after. What changed is that unattended work exists again — a cron sweeping
 * alert routes — and a process that spends without being watched is exactly what
 * a budget is for. Nothing else may import this module.
 *
 * What it protects is not the quota for its own sake. It is the RESERVE: the
 * scheduler stops well short of the day's ceiling so that a human pressing
 * Search at 9pm still gets an answer instead of a 429 caused by a robot.
 */

/** `X-RateLimit-Limit` is usually present, but the guard must work on a day
 *  nothing has observed one. A Pro key buys 1000 per UTC day. */
export const ASSUMED_DAILY_LIMIT = 1000;

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
 *
 * **The absent-observation case is the one that matters.** `source_quota` is
 * written only when a call is actually made, so on most days — days nobody
 * manually searched — there is no row at all when the first tick fires. Two
 * obvious answers are both wrong:
 *
 *   - *Refuse until something has been observed.* The scheduler would then never
 *     fire on any day it was the only thing running, which is nearly all of
 *     them. The feature would die silently, which is precisely the failure the
 *     codebase's anti-cron argument is about.
 *   - *Assume a full 1000.* Optimistic in the one direction that overspends, on
 *     the one day it mattered.
 *
 * So it **self-accounts** from our own records: whatever the last known limit
 * was, minus what today's runs already report spending (`search_runs.calls`,
 * added for this). That is an honest number derived from facts we hold, and the
 * first real `X-RateLimit-Remaining` of the day corrects it — which is why the
 * sweep also re-checks mid-flight rather than trusting this once.
 */
export function decideSweep(args: {
  /** Today's observation, if one exists for the CURRENT UTC day. */
  observation?: QuotaObservation;
  /** Sum of `search_runs.calls` for runs started today (UTC). */
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
 *
 * A row from a previous UTC day is simply not selected — `source_quota`'s key is
 * (source, day), so yesterday's exhausted count can never be mistaken for
 * today's, and the caller falls back to self-accounting exactly as it would on a
 * day with no row at all.
 */
export async function readBudgetState(
  db: D1Database,
  now: number,
): Promise<{ observation?: QuotaObservation; selfSpentToday: number }> {
  const day = utcDay(now);
  const [quotaRes, spentRes] = await db.batch([
    db
      .prepare(
        "SELECT remaining, limit_calls, observed_at FROM source_quota WHERE source = ? AND day = ?",
      )
      .bind(SEATSAERO_SOURCE_ID, day),
    db
      .prepare("SELECT COALESCE(SUM(calls), 0) AS spent FROM search_runs WHERE started_at >= ?")
      .bind(utcDayStart(now)),
  ]);

  const q = quotaRes?.results?.[0] as
    | { remaining: number; limit_calls: number | null; observed_at: number }
    | undefined;
  const spent = (spentRes?.results?.[0] as { spent: number } | undefined)?.spent ?? 0;

  return {
    observation: q
      ? { remaining: Number(q.remaining), limitCalls: q.limit_calls == null ? null : Number(q.limit_calls), observedAt: Number(q.observed_at) }
      : undefined,
    selfSpentToday: Number(spent),
  };
}
