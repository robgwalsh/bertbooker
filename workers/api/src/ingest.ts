import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { ChangeSummary } from "@bertbooker/core";
// The D1-coupled half of ingest is a subpath import on purpose — see the note
// in packages/core/src/index.ts.
import {
  applyTask,
  type IngestBatch,
  type IngestFinish,
  type IngestRunOpen,
} from "@bertbooker/core/ingest";
import type { Env, Vars } from "./bindings.js";
import { secretsMatch } from "./gate.js";
import { MAX_STORED_CHANGES, recordQuota, recordTask } from "./searchRun.js";

/**
 * Ingest for sources that cannot run on the Worker.
 *
 * Most sources do run here — seats.aero is a keyed vendor API and answers a
 * datacenter IP happily. A source pinned to `runtime: "local"` cannot, and
 * `packages/local-sources` runs those on your machine and POSTs the results to
 * the three endpoints below. Today that is PointsYeah alone, whose behaviour
 * from a datacenter IP has never been measured; the field records evidence, not
 * preference (docs/SOURCES.md).
 *
 * This module's only jobs are to authenticate the POST, hand each completed task
 * to `applyTask`, and keep the run's tallies current. It is deliberately thin:
 * everything about what a task MEANS — coverage, pruning, write-on-change —
 * lives in `applyTask`, shared with the Worker's own searches.
 *
 * Batches arrive **as the run proceeds**, not once at the end. A run can take
 * minutes and can die halfway; posting incrementally means the tasks that did
 * succeed are already durable.
 *
 * There is no history surface here. The tab that read one is gone; the
 * Alerts tab reads `search_runs` directly.
 */
export const ingest = new Hono<{ Bindings: Env; Variables: Vars }>();

/** D1 caps statements per batch; task logs can be chatty. */
const BATCH_SIZE = 50;

/**
 * The local runner has no browser and no password dialog to type into, so it
 * authenticates with this shared secret instead. `gate` accepts it in place of a
 * password session (see `gate.ts`), which makes this check the *only* thing
 * standing in front of ingest, not a second layer — so it covers all three
 * POSTs, not just the first.
 *
 * Unset means no check — the deliberate opposite of `APP_PASSWORD`'s fail-closed
 * posture, because a forgotten ingest token relaxes one check on ingest while a
 * vanishing password gate would publish the whole app. Note what that implies:
 * with `INGEST_TOKEN` unset, `gate` has nothing to recognise the runner by, so
 * its POSTs are refused before they reach here. Local gathering wants the secret
 * set in both `.env` (the runner) and `workers/api/.dev.vars` (the Worker).
 */
const ingestAuth = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
  const expected = c.env.INGEST_TOKEN;
  if (!expected) return next();
  // `secretsMatch` and not `!==`: this is the same secret `gate` already checked
  // on the way in, and two comparisons of one secret that disagree about their
  // rigour is a hole with a plausible cover story.
  const presented = c.req.header("X-Ingest-Token");
  if (!presented || !(await secretsMatch(presented, expected))) {
    return c.json({ error: "bad_ingest_token" }, 401);
  }
  return next();
};

ingest.use("/api/ingest/runs", ingestAuth);
ingest.use("/api/ingest/runs/*", ingestAuth);

/** Open a run. The id is minted by the runner so a run that dies before its
 *  first successful POST can be retried under the same identity. */
ingest.post("/api/ingest/runs", async (c) => {
  const email = c.get("userEmail");
  const b = await c.req.json<IngestRunOpen>();
  if (!b?.id || !b.origin || !b.destination) return c.json({ error: "bad_request" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO search_runs
       (id, user_email, trigger, origin, destination, date_start, date_end,
        programs_json, sources_json, status, started_at, tasks_planned, host,
        runner_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = 'running', started_at = excluded.started_at,
       tasks_planned = excluded.tasks_planned`,
  )
    .bind(
      b.id,
      email,
      b.trigger,
      b.origin,
      b.destination,
      b.dateStart,
      b.dateEnd,
      b.programs ? JSON.stringify(b.programs) : null,
      JSON.stringify(b.sources ?? []),
      b.startedAt,
      b.tasksPlanned ?? 0,
      b.host ?? null,
      b.runnerVersion ?? null,
    )
    .run();

  return c.json({ id: b.id }, 201);
});

/** Resolve a run the caller owns, or null. Every write below goes through this,
 *  so a run id guessed from another account is a 404 rather than a foothold. */
async function ownedRun(
  c: { env: Env; get: (k: "userEmail") => string },
  id: string,
): Promise<Record<string, unknown> | null> {
  return c.env.DB.prepare("SELECT * FROM search_runs WHERE id = ? AND user_email = ?")
    .bind(id, c.get("userEmail"))
    .first();
}

ingest.post("/api/ingest/runs/:id/tasks", async (c) => {
  const id = c.req.param("id");
  const run = await ownedRun(c, id);
  if (!run) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<IngestBatch>();
  const tasks = body?.tasks ?? [];
  const logs = body?.logs ?? [];

  const totals = {
    tasksOk: 0,
    tasksFailed: 0,
    offersFound: 0,
    snapshotsWritten: 0,
    snapshotsPruned: 0,
  };
  const changes: ChangeSummary[] = [];
  const applied: { taskKey: string; source: string; snapshotsWritten: number }[] = [];

  for (const task of tasks) {
    await recordTask(c.env.DB, id, task);
    if (task.status === "ok" || task.status === "empty") totals.tasksOk += 1;
    else if (task.status !== "skipped") totals.tasksFailed += 1;

    // A task that claims no coverage returns zeros without touching a row —
    // see `coverageSlices`. Applying it is still the right call: that is where
    // the "did anyone actually look?" decision lives, in one place.
    const out = await applyTask(c.env.DB, id, task);
    totals.offersFound += out.offersKept;
    totals.snapshotsWritten += out.snapshotsWritten;
    totals.snapshotsPruned += out.snapshotsPruned;
    changes.push(...out.changes);
    applied.push({
      taskKey: task.taskKey,
      source: task.source,
      snapshotsWritten: out.snapshotsWritten,
    });
  }

  if (logs.length) await writeLogs(c.env.DB, id, logs);
  if (body?.quota?.length) await recordQuota(c.env.DB, body.quota);

  // Accumulate onto the run. Read-modify-write of changes_json is safe here
  // because one runner owns a run for its whole lifetime.
  const prior: ChangeSummary[] = run.changes_json ? JSON.parse(String(run.changes_json)) : [];
  const merged = [...prior, ...changes].slice(0, MAX_STORED_CHANGES);

  await c.env.DB.prepare(
    `UPDATE search_runs SET
       tasks_ok = tasks_ok + ?, tasks_failed = tasks_failed + ?,
       offers_found = offers_found + ?, snapshots_written = snapshots_written + ?,
       snapshots_pruned = snapshots_pruned + ?, changes_json = ?
     WHERE id = ?`,
  )
    .bind(
      totals.tasksOk,
      totals.tasksFailed,
      totals.offersFound,
      totals.snapshotsWritten,
      totals.snapshotsPruned,
      JSON.stringify(merged),
      id,
    )
    .run();

  return c.json({ ok: true, applied, ...totals });
});

ingest.post("/api/ingest/runs/:id/finish", async (c) => {
  const id = c.req.param("id");
  const run = await ownedRun(c, id);
  if (!run) return c.json({ error: "not_found" }, 404);

  const b = await c.req.json<IngestFinish>();
  await c.env.DB.prepare(
    `UPDATE search_runs SET status = ?, finished_at = ?, duration_ms = ? - started_at, error = ?
      WHERE id = ?`,
  )
    .bind(b.status, b.finishedAt, b.finishedAt, b.error ?? null, id)
    .run();

  return c.json({ ok: true });
});

async function writeLogs(
  db: D1Database,
  runId: string,
  logs: NonNullable<IngestBatch["logs"]>,
): Promise<void> {
  const stmts = logs.map((l) =>
    db
      .prepare(
        `INSERT INTO search_logs (run_id, source, at_ms, level, message, fields_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        l.source ?? null,
        l.atMs,
        l.level ?? "info",
        l.message,
        l.fields ? JSON.stringify(l.fields) : null,
      ),
  );
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }
}
