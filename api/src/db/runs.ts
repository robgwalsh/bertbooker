import type { ChangeSummary } from "../models/change.js";
import type { Run } from "../models/wire/index.js";
import type { SearchTotals } from "../models/run.js";

/**
 * The `runs` table — a gathering run's bookkeeping.
 */

/** How many change summaries a run keeps. Display only — the authoritative
 *  record is `finds`. One cap, in one place: a second would mean two answers to
 *  "how much of a run's diff survives". */
export const MAX_STORED_CHANGES = 200;

/**
 * Mint the run row.
 *
 * `trigger` deliberately has no CHECK constraint, which is how 'alert' joined
 * 'search' for free.
 *
 * `origin`/`destination` are NOT NULL scalars and stay the route's primary
 * airports. The full pair list lives on each task's report, never in a
 * comma-joined column — see `SourceTaskReport.routes`.
 */
export async function insertRun(
  db: D1Database,
  v: {
    runId: string;
    trigger: string;
    /** The route this run is OF. `origin`/`destination` are only its primary
     *  airports, so two routes sharing a pair are otherwise indistinguishable. */
    routeId: number;
    origin: string;
    destination: string;
    startedAt: number;
    tasksPlanned: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs
         (id, trigger, route_id, origin, destination, status, started_at,
          tasks_planned)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(v.runId, v.trigger, v.routeId, v.origin, v.destination, v.startedAt, v.tasksPlanned)
    .run();
}

/** Validate a resume id against its trigger, so one caller cannot reopen the
 *  other's run. */
export async function selectRunForResume(
  db: D1Database,
  runId: string,
  trigger: string,
): Promise<{ id: string } | null> {
  return await db
    .prepare("SELECT id FROM runs WHERE id = ? AND trigger = ?")
    .bind(runId, trigger)
    .first<{ id: string }>();
}

/** A paused sweep left a run to resume; picking it up is what keeps one route's
 *  coverage on one run row. The counters are where the resumed pass finds its
 *  place in the plan: `tasks_ok + tasks_failed` is the index to start from. */
export async function selectResumableAlertRun(
  db: D1Database,
  routeId: number,
): Promise<{ id: string; tasks_planned: number; tasks_ok: number; tasks_failed: number } | null> {
  return await db
    .prepare(
      `SELECT id, tasks_planned, tasks_ok, tasks_failed FROM runs
        WHERE route_id = ? AND trigger = 'alert' AND status = 'running'
        ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(routeId)
    .first<{ id: string; tasks_planned: number; tasks_ok: number; tasks_failed: number }>();
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

/** The pass died rather than completed. The RAW message is recorded — this row
 *  is read by whoever is debugging and by `GET /api/alerts/runs`, and it should
 *  say exactly what happened. What reaches a browser is sanitised separately;
 *  see `clientMessage`. */
export async function failRun(
  db: D1Database,
  runId: string,
  finishedAt: number,
  error: string,
): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
    .bind(finishedAt, error, runId)
    .run();
}

/** Recent sweeps. A sweep is a `runs` row like any other, told apart only by its
 *  trigger. */
export async function selectAlertRuns(db: D1Database, limit: number): Promise<Run[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM runs
        WHERE trigger = 'alert'
        ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Run>();
  return results ?? [];
}

/**
 * Is the sweep cycle over — nothing due, nothing mid-run?
 *
 * Two scalar subqueries in one row, so this is one query rather than two. It
 * reads `tracked_routes` as well as `runs`, and lives here because "no alert run
 * is still `running`" is the half with the status column.
 *
 * A gap worth knowing about: the `due` count has no notion of chunks, while
 * `dueRoutes` skips any route whose window has expired. So an expired-window
 * alert route is never swept, never stamped, counts as due forever, and no
 * digest flushes for any route while it is enabled. If that is ever tightened,
 * the honest fix is to give this subquery the same window test the planner
 * applies rather than to loosen the flush condition.
 */
export async function selectCycleCounts(
  db: D1Database,
  attemptedBefore: number,
): Promise<{ due: number; running: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tracked_routes
           WHERE alerts_enabled = 1
             AND (alert_last_attempt_at IS NULL OR alert_last_attempt_at <= ?)) AS due,
         (SELECT COUNT(*) FROM runs
           WHERE trigger = 'alert' AND status = 'running') AS running`,
    )
    .bind(attemptedBefore)
    .first<{ due: number; running: number }>();
  return { due: row?.due ?? 0, running: row?.running ?? 0 };
}

/**
 * What today's runs report spending, as a STATEMENT rather than a result.
 *
 * A builder because its one caller batches it against a `source_quota` read, and
 * that pairing is the budget guard's single round trip. A covering seek on
 * `idx_runs_spend`, the one index on this table that exists for this query
 * alone. See `selectBudgetRows` in `db/sourceQuota.ts`, its only composer.
 */
export function spentSinceStatement(db: D1Database, since: number): D1PreparedStatement {
  return db
    .prepare("SELECT COALESCE(SUM(calls), 0) AS spent FROM runs WHERE started_at >= ?")
    .bind(since);
}

/**
 * Delete run rows older than the retention window.
 *
 * Deliberately unbounded by a LIMIT: at ~50 rows a day the steady-state delete
 * is a handful, and a first run after a long gap should get it over with rather
 * than leave a backlog that never drains. A run still `running` is spared
 * whatever its age — that is a paused search waiting to resume, and deleting it
 * would strand the sweep that owns it.
 */
export async function deleteOldRuns(db: D1Database, startedBefore: number): Promise<void> {
  await db
    .prepare(`DELETE FROM runs WHERE started_at < ? AND status <> 'running'`)
    .bind(startedBefore)
    .run();
}
