import type { ChangeSummary } from "../domain/diff.js";
import type { SourceQuotaObservation } from "../ingest/types.js";

/**
 * The writers for a gathering run's bookkeeping — `runs` and `source_quota`.
 *
 * They live here rather than in `search/run.ts` because they are not search
 * logic: they take a run id and a report and write a row. Keeping them there
 * meant the enrichment path had to import the whole search engine to record a
 * quota observation it read off a `/trips/{id}` response header.
 *
 * `recordQuota` is worth stating plainly: **it is a display writer, not a
 * guard.** Nothing here reads the quota back before spending. The one reader
 * that consults it before a call is `alerts/budget.ts`, the scheduled sweep.
 */

/** How many change summaries a run keeps. Display only — the authoritative
 *  record is `finds`. One cap, in one place: a second would mean two answers to
 *  "how much of a run's diff survives". */
export const MAX_STORED_CHANGES = 200;

/** What a pass accumulated, written onto the `runs` row by {@link finishRun}. */
export interface SearchTotals {
  ok: number;
  failed: number;
  offers: number;
  written: number;
  pruned: number;
  calls: number;
}

/**
 * Close out the run row.
 *
 * Totals ACCUMULATE across passes: `totals` counts only what this pass did, and
 * a resumed run must not overwrite what the previous one recorded. That is not
 * bookkeeping — `tasks_ok + tasks_failed` is the index a resumed pass starts
 * from, so an overwrite would re-run work already done. `finished_at` stays NULL
 * while paused, so a run in progress never looks complete.
 *
 * `written` and `pruned` are reported to the caller and not stored: the stream's
 * `run_done` frame carries them from memory, and nothing has ever read them back
 * out of the database.
 */
export async function finishRun(
  db: D1Database,
  runId: string,
  args: {
    status: string;
    paused: boolean;
    finishedAt: number;
    totals: SearchTotals;
    changes: ChangeSummary[];
  },
): Promise<void> {
  const { status, paused, finishedAt, totals, changes } = args;

  // Read-modify-write of changes_json is safe: one pass owns a run at a time,
  // and a resumed pass is strictly after the one it continues.
  const prior = await db
    .prepare("SELECT changes_json FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ changes_json: string | null }>();
  let merged: ChangeSummary[] = changes;
  if (prior?.changes_json) {
    try {
      merged = [...(JSON.parse(prior.changes_json) as ChangeSummary[]), ...changes];
    } catch {
      /* a malformed blob is display-only; don't lose this pass over it */
    }
  }

  await db
    .prepare(
      `UPDATE runs SET
         status = ?,
         finished_at = ?,
         tasks_ok = COALESCE(tasks_ok, 0) + ?,
         tasks_failed = COALESCE(tasks_failed, 0) + ?,
         offers_found = COALESCE(offers_found, 0) + ?,
         calls = COALESCE(calls, 0) + ?,
         changes_json = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      paused ? null : finishedAt,
      totals.ok,
      totals.failed,
      totals.offers,
      totals.calls,
      JSON.stringify(merged.slice(0, MAX_STORED_CHANGES)),
      runId,
    )
    .run();
}

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
 *
 * For every INTERACTIVE path this is a **display, not a guard**: search and
 * enrich spend first and report after, because nobody needs protecting from a
 * call they deliberately asked for. It has exactly ONE reader that consults it
 * before spending, and that is `alerts/budget.ts` — the scheduled sweep, which
 * spends with nobody watching.
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
