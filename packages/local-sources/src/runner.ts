import {
  classifyError,
  runStatus,
  todayISO,
  type IngestLogLine,
  type RunnableSource,
  type RunStatus,
  type SourceCtx,
  type SourceQuery,
  type SourceQuotaObservation,
  type SourceTask,
  type SourceTaskReport,
  type SourceTaskStatus,
} from "@bertbooker/core";
import type { IngestClient } from "./ingest.js";

// `classifyError` and `runStatus` live in core because the Worker uses them too,
// and the two processes have to agree about what `blocked` means or coverage —
// and therefore pruning — diverges between them. Re-exported so this module's
// surface is self-contained.
export { classifyError, runStatus } from "@bertbooker/core";

/** Progress a caller can watch. Deliberately excludes the offers — those are
 *  already on their way to D1 and would bloat every frame. */
export type RunEvent =
  | {
      type: "run_start";
      runId: string;
      query: SourceQuery;
      sources: string[];
      tasksPlanned: number;
    }
  | { type: "source_skipped"; source: string; reason: string }
  | {
      type: "task_start";
      source: string;
      taskKey: string;
      dates: string[];
      index: number;
      total: number;
    }
  | {
      type: "task_done";
      source: string;
      taskKey: string;
      status: SourceTaskStatus;
      offersFound: number;
      durationMs: number;
      error?: string;
    }
  | { type: "log"; line: IngestLogLine }
  | {
      type: "run_done";
      runId: string;
      status: RunStatus;
      tasksOk: number;
      tasksFailed: number;
      offersFound: number;
      durationMs: number;
    }
  | { type: "error"; message: string };

export interface RunnerOptions {
  runId: string;
  query: SourceQuery;
  sources: RunnableSource[];
  ingest: IngestClient;
  today?: string;
  host?: string;
  version?: string;
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
  /** Push to the API every N completed tasks. Small on purpose: a run that dies
   *  halfway should have already stored what it found. */
  flushEvery?: number;
  /** Randomised gap between tasks. This is a personal tool at two users'
   *  volume — being slow costs nothing. Set both to 0 in tests. */
  pacing?: { minMs: number; maxMs: number };
}

export interface RunnerResult {
  runId: string;
  status: RunStatus;
  tasksPlanned: number;
  tasksOk: number;
  tasksFailed: number;
  offersFound: number;
  durationMs: number;
  perSource: Record<string, { ok: number; failed: number; offers: number }>;
}

const DEFAULT_PACING = { minMs: 800, maxMs: 2500 };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/**
 * Run one gather: plan every capable source, execute task by task, and stream
 * results into the API as they land.
 *
 * Sources run **sequentially**, and so do their tasks. Parallelism would buy
 * wall-clock on a job nobody is watching in real time, at the cost of hammering
 * a free service that has been good to us.
 */
export async function runSources(opts: RunnerOptions): Promise<RunnerResult> {
  const today = opts.today ?? todayISO();
  const startedAt = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const flushEvery = opts.flushEvery ?? 4;

  const logs: IngestLogLine[] = [];
  const log = (
    source: string | undefined,
    level: IngestLogLine["level"],
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    const line: IngestLogLine = { source, atMs: Date.now() - startedAt, level, message, fields };
    logs.push(line);
    emit({ type: "log", line });
  };

  // ---- plan -----------------------------------------------------------------
  const planned: { source: RunnableSource; task: SourceTask }[] = [];
  const active: RunnableSource[] = [];
  for (const source of opts.sources) {
    if (!source.supports(opts.query)) {
      emit({ type: "source_skipped", source: source.id, reason: "supports() declined" });
      log(source.id, "info", `${source.id}: declined this route/program filter`);
      continue;
    }
    const tasks = source.plan(opts.query, today);
    if (tasks.length === 0) {
      emit({ type: "source_skipped", source: source.id, reason: "nothing in horizon" });
      log(source.id, "info", `${source.id}: nothing within its ~${source.horizonDays}-day horizon`);
      continue;
    }
    active.push(source);
    for (const task of tasks) planned.push({ source, task });
  }

  emit({
    type: "run_start",
    runId: opts.runId,
    query: opts.query,
    sources: active.map((s) => s.id),
    tasksPlanned: planned.length,
  });

  await opts.ingest.open({
    id: opts.runId,
    trigger: "local",
    origin: opts.query.origin,
    destination: opts.query.destination,
    dateStart: opts.query.dateStart,
    dateEnd: opts.query.dateEnd,
    programs: opts.query.programs,
    sources: active.map((s) => s.id),
    startedAt,
    tasksPlanned: planned.length,
    host: opts.host,
    runnerVersion: opts.version,
  });

  // ---- execute --------------------------------------------------------------
  const totals = { ok: 0, failed: 0, offers: 0 };
  const perSource: RunnerResult["perSource"] = {};
  let pending: SourceTaskReport[] = [];
  // Quota observations from metered sources. Keyed by source id so a run with
  // several tasks against one API sends the newest reading, not four of them.
  const quota = new Map<string, SourceQuotaObservation>();
  let aborted = false;

  const flush = async () => {
    // `quota.size` belongs in this guard: the last flush of a run often has no
    // tasks and no logs left, and dropping it there would throw away the most
    // recent (and only interesting) reading of the day.
    if (!pending.length && !logs.length && !quota.size) return;
    const batch = { tasks: pending, logs: [...logs], quota: [...quota.values()] };
    pending = [];
    logs.length = 0;
    quota.clear();
    await opts.ingest.push(opts.runId, batch);
  };

  const openedSources = new Set<RunnableSource>();
  try {
    for (const [index, { source, task }] of planned.entries()) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      const bucket = (perSource[source.id] ??= { ok: 0, failed: 0, offers: 0 });
      const ctx: SourceCtx = {
        today,
        signal: opts.signal,
        log: (msg, fields) => log(source.id, "info", msg, fields),
      };

      if (source.open && !openedSources.has(source)) {
        await source.open(ctx);
        openedSources.add(source);
      }

      emit({
        type: "task_start",
        source: source.id,
        taskKey: task.key,
        dates: task.dates,
        index,
        total: planned.length,
      });

      const taskStarted = Date.now();
      let report: SourceTaskReport;
      try {
        const out = await source.run(task, ctx);
        // `empty` is not a failure — it claims coverage, which is what lets a
        // seat that genuinely went away be pruned. See COVERAGE_CLAIMING_STATUSES.
        const status: SourceTaskStatus = out.offers.length ? "ok" : "empty";
        report = {
          source: source.id,
          taskKey: task.key,
          origin: task.origin,
          destination: task.destination,
          dates: task.dates,
          programs: task.programs,
          status,
          startedAt: taskStarted,
          finishedAt: Date.now(),
          coveredDates: out.coveredDates,
          finalUrl: out.finalUrl,
          httpStatus: out.httpStatus,
          capture: out.capture,
          offers: out.offers,
        };
        totals.ok += 1;
        bucket.ok += 1;
        totals.offers += out.offers.length;
        bucket.offers += out.offers.length;
        // A fact about the source's daily allowance, not about this task. Last
        // one wins — it is the one closest to now.
        if (out.quota) quota.set(out.quota.source, out.quota);
        for (const note of out.notes ?? []) log(source.id, "info", note);
      } catch (err) {
        const { status, message } = classifyError(err);
        report = {
          source: source.id,
          taskKey: task.key,
          origin: task.origin,
          destination: task.destination,
          dates: task.dates,
          programs: task.programs,
          status,
          startedAt: taskStarted,
          finishedAt: Date.now(),
          error: message,
          // No offers and — critically — no coverage claim. A refused task has
          // said nothing about whether the award space still exists.
          offers: [],
        };
        totals.failed += 1;
        bucket.failed += 1;
        log(source.id, "error", `${task.key}: ${status} — ${message}`);
      }

      emit({
        type: "task_done",
        source: source.id,
        taskKey: task.key,
        status: report.status,
        offersFound: report.offers.length,
        durationMs: report.finishedAt - report.startedAt,
        error: report.error,
      });

      pending.push(report);
      if (pending.length >= flushEvery) await flush();

      const isLast = index === planned.length - 1;
      if (!isLast && pacing.maxMs > 0) {
        const jitter = pacing.minMs + Math.random() * Math.max(0, pacing.maxMs - pacing.minMs);
        await sleep(jitter, opts.signal).catch(() => {
          aborted = true;
        });
        if (aborted) break;
      }
    }
  } finally {
    for (const source of openedSources) {
      await source.close?.().catch((err: unknown) =>
        log(source.id, "warn", `close failed: ${String(err)}`),
      );
    }
    await flush();
  }

  const status: Exclude<RunStatus, "running"> = aborted
    ? "aborted"
    : runStatus(totals.ok, totals.failed, planned.length);
  const finishedAt = Date.now();
  await opts.ingest.finish(opts.runId, { status, finishedAt });

  const result: RunnerResult = {
    runId: opts.runId,
    status,
    tasksPlanned: planned.length,
    tasksOk: totals.ok,
    tasksFailed: totals.failed,
    offersFound: totals.offers,
    durationMs: finishedAt - startedAt,
    perSource,
  };
  emit({
    type: "run_done",
    runId: opts.runId,
    status,
    tasksOk: totals.ok,
    tasksFailed: totals.failed,
    offersFound: totals.offers,
    durationMs: result.durationMs,
  });
  return result;
}
