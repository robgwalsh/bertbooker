import type { ChangeSummary } from "../domain/diff.js";
import type { SourceQuotaObservation, SourceTaskReport } from "../ingest/types.js";
import type { RunStatus } from "../../../shared/src/wire/domain.js";

/**
 * The three writers for a gathering run's bookkeeping tables — `search_runs`,
 * `search_tasks` and `source_quota`.
 *
 * These lived in `search/run.ts` and are not search logic: they take a run id
 * and a report and write a row. Keeping them there meant the enrichment path had to
 * import the whole search engine to record a quota observation it read off a
 * `/trips/{id}` response header, which made the enrichment path look like it
 * depended on the searcher when it only shared three tables with it.
 *
 * `recordQuota` in particular is worth stating plainly: **it is a display
 * writer, not a guard.** Nothing here reads the quota back before spending. The
 * one reader that consults it before a call is `alerts/budget.ts`, the scheduled
 * sweep — see docs/ALERTS.md §7.
 */

/** How many change summaries a run keeps. Display only — the authoritative
 *  record is the snapshot rows themselves. One cap, in one place: a second would
 *  mean two answers to "how much of a run's diff survives". */
export const MAX_STORED_CHANGES = 200;

/** What a pass accumulated, written onto the `search_runs` row by
 *  {@link finishRun}. `search/run.ts` re-exports this. */
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
 * a resumed run must not overwrite what the previous one recorded. `finished_at`
 * stays NULL while paused, so a run in progress never looks complete.
 *
 * `changes_json` and `calls` are new here relative to the pre-extraction search
 * path, which recorded neither — the ingest path has always stored the
 * diff, and nothing anywhere recorded what a run actually spent.
 * The alert scheduler needs both: the diff is what it emails about, and the
 * measured spend is what it paces against.
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
    .prepare("SELECT changes_json FROM search_runs WHERE id = ?")
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
      `UPDATE search_runs SET
         status = ?,
         finished_at = ?,
         duration_ms = CASE WHEN ? IS NULL THEN duration_ms ELSE ? - started_at END,
         tasks_ok = COALESCE(tasks_ok, 0) + ?,
         tasks_failed = COALESCE(tasks_failed, 0) + ?,
         offers_found = COALESCE(offers_found, 0) + ?,
         snapshots_written = COALESCE(snapshots_written, 0) + ?,
         snapshots_pruned = COALESCE(snapshots_pruned, 0) + ?,
         calls = COALESCE(calls, 0) + ?,
         changes_json = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      paused ? null : finishedAt,
      paused ? null : finishedAt,
      finishedAt,
      totals.ok,
      totals.failed,
      totals.offers,
      totals.written,
      totals.pruned,
      totals.calls,
      JSON.stringify(merged.slice(0, MAX_STORED_CHANGES)),
      runId,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Row writers shared with the local ingest endpoint
//
// This file is their primary caller, but `ingest.ts` uses both too: a source
// run locally produces exactly the same kind of row as a Worker-side search,
// and two writers of one table would drift on the conflict clause.
// ---------------------------------------------------------------------------


/** Upsert the task row. `(run_id, source, task_key)` is UNIQUE so a re-POSTed
 *  batch updates in place instead of duplicating — the local runner retries a
 *  failed POST, and a doubled row would double the run's tallies. */
export async function recordTask(
  db: D1Database,
  runId: string,
  t: SourceTaskReport,
): Promise<void> {
  await db
    .prepare(
      // No `artifact_path`: that column held a path on the local runner's disk
      // to a failed task's dump, and neither the runner nor the column exists
      // any more (migration 0002).
      `INSERT INTO search_tasks
         (run_id, source, task_key, origin, destination, dates_json, status,
          offers_found, attempts, started_at, finished_at, duration_ms, error,
          final_url, http_status, capture_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, source, task_key) DO UPDATE SET
         status = excluded.status, offers_found = excluded.offers_found,
         attempts = excluded.attempts, started_at = excluded.started_at,
         finished_at = excluded.finished_at, duration_ms = excluded.duration_ms,
         error = excluded.error, final_url = excluded.final_url,
         http_status = excluded.http_status, capture_json = excluded.capture_json`,
    )
    .bind(
      runId,
      t.source,
      t.taskKey,
      t.origin,
      t.destination,
      JSON.stringify(t.dates),
      t.status,
      t.offers?.length ?? 0,
      t.attempts ?? 1,
      t.startedAt,
      t.finishedAt,
      Math.max(0, t.finishedAt - t.startedAt),
      t.error ?? null,
      t.finalUrl ?? null,
      t.httpStatus ?? null,
      t.capture == null ? null : JSON.stringify(t.capture),
    )
    .run();
}

/**
 * Record what a metered source has left in its daily allowance.
 *
 * The day bucket is derived in **UTC** from the observer's `observedAt`, not from
 * the Worker's local anything, because that is when seats.aero's allowance
 * resets. Deriving it here rather than trusting a `day` field off the wire keeps
 * one clock in charge of the bucketing.
 *
 * The `WHERE` on the upsert is the interesting part: batches can be re-POSTed
 * after a failure, and an older observation arriving late must not roll
 * `remaining` back up to a number that has since been spent.
 *
 * For every INTERACTIVE path this is a **display, not a guard**: search and
 * enrich spend first and report after, because nobody needs protecting from a
 * call they deliberately asked for.
 *
 * It has exactly ONE reader that consults it before spending, and that reader is
 * `alerts/budget.ts` — the scheduled sweep, which spends with nobody watching.
 * A budget guard anywhere else is out of place. docs/ALERTS.md §7.
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
