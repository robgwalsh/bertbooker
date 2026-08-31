import type { SourceQuota } from "../models/wire/index.js";
import type { SourceQuotaObservation } from "../models/task.js";
import type { BudgetRows } from "../models/run.js";
import { spentSinceStatement } from "./runs.js";

/**
 * The `source_quota` table — what a metered source has left in its daily
 * allowance, keyed by (source, UTC day).
 *
 * **For every INTERACTIVE path this is a display, not a guard.** Search and
 * enrich spend first and report after, because nobody needs protecting from a
 * call they deliberately asked for. Exactly ONE caller reads it before spending,
 * and that is `features/alerts/budget.ts` — the scheduled sweep, which spends
 * with nobody watching. `selectBudgetRows` below is the only function here it
 * calls, and it is the only function here with one caller.
 */

/**
 * Record what a metered source has left in its daily allowance.
 *
 * The day bucket is derived in **UTC** from the observer's `observedAt`, because
 * that is when seats.aero's allowance resets. Deriving it here rather than
 * trusting a `day` field off the wire keeps one clock in charge of the
 * bucketing.
 *
 * The `WHERE` on the upsert is the interesting part: an older observation
 * arriving late must not roll `remaining` back up to a number that has since
 * been spent.
 */
export async function recordQuota(
  db: D1Database,
  quota: SourceQuotaObservation[],
): Promise<void> {
  for (const q of quota) {
    if (!q?.source || !Number.isFinite(q.remaining) || !Number.isFinite(q.observedAt)) continue;
    const day = new Date(q.observedAt).toISOString().slice(0, 10);
    await db
      .prepare(
        `INSERT INTO source_quota (source, day, remaining, limit_calls, observed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, day) DO UPDATE SET
           remaining   = excluded.remaining,
           limit_calls = COALESCE(excluded.limit_calls, source_quota.limit_calls),
           observed_at = excluded.observed_at
         WHERE excluded.observed_at >= source_quota.observed_at`,
      )
      .bind(q.source, day, q.remaining, q.limit ?? null, q.observedAt)
      .run();
  }
}

/** The last N days, for the app-bar chip. A day that ran dry stays visible the
 *  morning after. */
export async function selectQuotaSince(db: D1Database, sinceDay: string): Promise<SourceQuota[]> {
  const { results } = await db
    .prepare(
      `SELECT source, day, remaining, limit_calls, observed_at
         FROM source_quota WHERE day >= ?
        ORDER BY day DESC, source`,
    )
    .bind(sinceDay)
    .all<SourceQuota>();
  return results;
}

/**
 * The two rows the budget guard reasons from, in one round trip.
 *
 * **ONE CALLER — `features/alerts/budget.ts`, and it must stay one.** This is
 * the only read of a quota that happens BEFORE a call is spent, and the whole
 * argument for allowing unattended spending rests on that being a single place.
 * If a second caller appears here, that is the guard coming back somewhere new
 * and it needs the argument in CLAUDE.md to survive first.
 *
 * A row from a previous UTC day is simply not selected — `source_quota`'s key is
 * (source, day) — so yesterday's exhausted count can never be mistaken for
 * today's, and the caller falls back to self-accounting exactly as it would on a
 * day with no row at all.
 */
export async function selectBudgetRows(
  db: D1Database,
  source: string,
  day: string,
  since: number,
): Promise<BudgetRows> {
  const [quotaRes, spentRes] = await db.batch([
    db
      .prepare(
        "SELECT remaining, limit_calls, observed_at FROM source_quota WHERE source = ? AND day = ?",
      )
      .bind(source, day),
    spentSinceStatement(db, since),
  ]);

  const q = quotaRes?.results?.[0] as BudgetRows["quota"];
  const spent = (spentRes?.results?.[0] as { spent: number } | undefined)?.spent ?? 0;
  return { quota: q, spent: Number(spent) };
}
