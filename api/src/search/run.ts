import type { ChangeSummary } from "../domain/diff.js";
import { planRoute, type RoutePair } from "../domain/routing.js";
import { applyTask } from "../ingest/apply.js";
import { runStatus, type SourceQuotaObservation, type SourceTaskReport } from "../ingest/types.js";
import { callMetadata, datesIn, planSeatsAeroChunks, runSeatsAeroChunk, SEATSAERO_PROGRAMS, SEATSAERO_SOURCE_ID, type SeatsAeroCall, type SeatsAeroChunk, seatsAeroTaskKey } from "../providers/seatsaero.js";
import { classifyError, type FetchLike, makeTransport } from "../providers/transport.js";
import { todayISO } from "../providers/window.js";
import { finishRun, recordQuota, recordTask, type SearchTotals } from "../db/runs.js";

/** Declared in `../db/runs.ts`, beside the `search_runs` writer that consumes
 *  them, and re-exported here so this module reads as the search API it is. */
export { MAX_STORED_CHANGES } from "../db/runs.js";
export type { SearchTotals } from "../db/runs.js";


/**
 * The seats.aero search, as an engine rather than an endpoint.
 *
 * **This is the one outbound data call the Worker makes, and the reason it is
 * allowed.** Every other source in this repo reads an airline's own site, and
 * airlines refuse datacenter IPs — United answers Akamai 428 and Delta 444 to raw
 * HTTP even from a residential connection, and Delta denies even a verbatim
 * replay of a real browser session. seats.aero is
 * a keyed vendor API: it authenticates the *key*, not the client, and does not
 * care that Cloudflare made the request (docs/SEATS-AERO.md). If you
 * are adding a `fetch` to an airline in this worker, stop.
 *
 * It lives here rather than inside the Hono handler because it now has **two
 * callers and one behaviour** — the same idiom `applyTask` has. `endpoints/search.ts`
 * streams it to a person who pressed Search; `alerts/sweep.ts` runs it
 * unattended on a cron and reads the changes it returns. Two implementations of
 * "search a route and ingest the result" would eventually disagree about
 * coverage, which is the one thing in this pipeline that silently destroys data.
 *
 * ## Three functions, not one, and the split is the safety property
 *
 * `endpoints/search.ts` holds a rule that a single entry point cannot keep: **everything
 * fallible happens before the stream opens**, because once the first byte is
 * written the response is committed to 200 and an `error` frame is all that is
 * left. A missing `SEATS_AERO_API_KEY` must be a 503, never an empty result that
 * would read as "no award space".
 *
 *   1. `planSearchPass` — every refusal, as a typed code. Reads only.
 *   2. `openSearchRun`  — the first WRITE: mint or resume the `search_runs` row.
 *   3. `runSearchPass`  — the loop that spends calls.
 *
 * The scheduler needs them separate for a second reason: it must know what a
 * sweep will cost (`plan.chunks.length`) *before* deciding whether the day's
 * allowance can afford it, and it must not leave a `search_runs` row behind for
 * a sweep the budget refused. `search_runs.status` has a CHECK constraint with
 * no `'skipped'` in it, and `search_coverage.run_id` is a foreign key — so the
 * ordering is forced anyway.
 */

/** What the SPA sees. Newline-delimited JSON, one object per line.
 *
 *  DEFINED IN `shared/src/wire/search.ts` and re-exported here, so this module's
 *  consumers (`endpoints/search.ts` re-exports it again) are unchanged. It used to be
 *  declared here and mirrored by hand in the SPA; the mirror is gone, and with
 *  it the note that used to sit on this line naming a type — `RouteSearchEvent`
 *  — that had not existed for some time. */
export type { SearchEvent } from "../../../shared/src/wire/search.js";
// Again as a plain import: `export … from` re-exports without binding the name
// in this module, and the run loop below is typed in terms of it.
import type { SearchEvent } from "../../../shared/src/wire/search.js";

/**
 * Response bytes one search will stream back for display, across all its calls.
 *
 * Bodies are the expensive half of the call record — a full page is up to 1000
 * rows — and they are held in the tab's memory for the session. This bounds a
 * pathological search (5 chunks × 5 pages) to something a browser can hold. Past
 * it, calls still stream with their timing and status; only the body is dropped,
 * and the UI says so rather than showing an empty payload.
 *
 * The unattended caller passes 0: nobody is watching, and a cron holding
 * megabytes of captured JSON to throw away is pure CPU against a 30-second
 * budget.
 */
export const CAPTURE_BUDGET_BYTES = 6_000_000;

/**
 * Outbound seats.aero calls one HTTP request will make before handing back a
 * `run_continue`.
 *
 * A Worker has a per-request subrequest budget, and this used to be bounded
 * structurally: 5 chunks × 5 pages = 25, full stop. `include_trips` forces a
 * smaller page, so a chunk now takes up to 10 of them and 5 chunks can reach 50
 * calls — no longer a number to leave to luck.
 *
 * So the search became resumable instead of capped. Every task is durable the
 * moment `applyTask` returns, so stopping between tasks costs nothing and the
 * client just asks for the rest. This also removes the wall-clock risk on a wide
 * search, which was a real failure mode waiting to happen.
 */
export const MAX_CALLS_PER_REQUEST = 25;

export interface TrackedRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  date_start: string;
  date_end: string;
  /** 1 = search BOTH directions. Unlike every other per-route flag this one
   *  changes what is gathered, not what is shown. */
  round_trip: number;
}

/** Every way a search can be refused before it spends anything.
 *
 *  A CODE rather than a status or a message, because the two callers report it
 *  differently and neither should be parsing the other's prose: `endpoints/search.ts` maps
 *  it to an HTTP status, the scheduler maps it to a named skip reason that lands
 *  in the Alerts tab. */
export type PlanFailure =
  | { code: "not_found" }
  | { code: "no_seats_aero_key" }
  | { code: "window_outside_horizon"; today: string }
  | { code: "bad_route_spec"; message: string }
  | { code: "nothing_to_resume"; total: number }
  | { code: "run_not_found" };

export interface SearchPlan {
  route: TrackedRouteRow;
  apiKey: string;
  email: string;
  origins: string[];
  destinations: string[];
  pairs: RoutePair[];
  chunks: SeatsAeroChunk[];
  /** One task per date chunk, so resuming is an index into one list rather than
   *  a pair of cursors. */
  tasks: { chunk: SeatsAeroChunk }[];
  /** Where this pass starts in `tasks`. */
  from: number;
}

export interface SearchPassResult {
  runId: string;
  /** Ran out of budget rather than out of work. The run row stays `running`. */
  paused: boolean;
  /** Where the next pass should start when `paused`. */
  nextIndex: number;
  total: number;
  totals: SearchTotals;
  /** What changed, for the caller that cares. `endpoints/search.ts` ignores these (they
   *  are persisted to `search_runs.changes_json` either way); the alert sweep
   *  is the reason they are returned rather than only stored. */
  changes: ChangeSummary[];
  status: "ok" | "partial" | "failed" | "aborted" | "running";
  /** Set when the pass died rather than completed — the caller has already been
   *  handed an `error` frame if it was streaming. */
  error?: string;
}

/** A JSON-array column, falling back to the scalar beside it. NULL means "use
 *  the scalar", and a bad value must read as "not set" rather than throw a
 *  search away. */
function airportColumn(json: string | null, fallback: string): string[] {
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
    } catch {
      /* fall through to the scalar */
    }
  }
  return [fallback];
}

/**
 * Everything that can refuse a search, before anything is written or spent.
 *
 * Reads only. Both callers depend on that: the HTTP handler needs to answer with
 * a real status code before the stream opens, and the scheduler needs the chunk
 * count to price the sweep before deciding whether to run it at all.
 */
export async function planSearchPass(
  db: D1Database,
  opts: {
    email: string;
    routeId: number;
    apiKey?: string;
    from?: number;
    today?: string;
  },
): Promise<{ ok: true; plan: SearchPlan } | { ok: false; failure: PlanFailure }> {
  const route = await db
    .prepare(
      `SELECT id, origin, destination, origins, destinations, date_start, date_end, round_trip
         FROM tracked_routes WHERE id = ? AND user_email = ?`,
    )
    .bind(opts.routeId, opts.email)
    .first<TrackedRouteRow>();
  if (!route) return { ok: false, failure: { code: "not_found" } };

  // "We have no key" and "there is no award space" are the same absence and
  // opposite facts — the confusion this whole architecture exists to prevent.
  const apiKey = opts.apiKey;
  if (!apiKey) return { ok: false, failure: { code: "no_seats_aero_key" } };

  const today = opts.today ?? todayISO();
  const chunks = planSeatsAeroChunks(route.date_start, route.date_end, today);
  if (chunks.length === 0) {
    return { ok: false, failure: { code: "window_outside_horizon", today } };
  }

  // The route as a set of city pairs — one call covers the whole cross product,
  // so a multi-airport route costs a plain one's calls.
  //
  // A ROUND-TRIP route puts every airport on both sides (`searchSpec`), so the
  // same single call also brings back the return direction. It costs no extra
  // calls; it costs rows, and a chunk that paginates out narrows its own
  // coverage claim rather than over-claiming.
  const roundTrip = route.round_trip === 1;
  let origins: string[];
  let destinations: string[];
  let pairs: RoutePair[];
  try {
    ({ origins, destinations, pairs } = planRoute(
      {
        origins: airportColumn(route.origins, route.origin),
        destinations: airportColumn(route.destinations, route.destination),
      },
      roundTrip,
    ));
  } catch (err) {
    // An unsearchable route is a configuration error, not an empty result.
    return { ok: false, failure: { code: "bad_route_spec", message: (err as Error).message } };
  }

  const tasks = chunks.map((chunk) => ({ chunk }));
  const from = Math.max(0, Number(opts.from ?? 0) || 0);
  if (from >= tasks.length) {
    return { ok: false, failure: { code: "nothing_to_resume", total: tasks.length } };
  }

  return {
    ok: true,
    plan: { route, apiKey, email: opts.email, origins, destinations, pairs, chunks, tasks, from },
  };
}

/**
 * Mint the run row, or pick up the one a paused pass left behind.
 *
 * The first write, and deliberately separate from planning: a budget-refused
 * sweep must leave no trace, and `search_runs.status`'s CHECK constraint has no
 * `'skipped'` to record one with.
 *
 * Resuming REUSES the run row, because `search_coverage.run_id` is a foreign key
 * to it and a second row would split one search's coverage across two runs —
 * making "was this route checked" answerable only by knowing both ids.
 */
export async function openSearchRun(
  db: D1Database,
  plan: SearchPlan,
  opts: { trigger: string; resumeRunId?: string; startedAt?: number; routeId?: number },
): Promise<{ ok: true; runId: string; startedAt: number } | { ok: false; failure: PlanFailure }> {
  const startedAt = opts.startedAt ?? Date.now();

  if (opts.resumeRunId) {
    const existing = await db
      .prepare("SELECT id FROM search_runs WHERE id = ? AND user_email = ? AND trigger = ?")
      .bind(opts.resumeRunId, plan.email, opts.trigger)
      .first<{ id: string }>();
    if (!existing) return { ok: false, failure: { code: "run_not_found" } };
    return { ok: true, runId: existing.id, startedAt };
  }

  const runId = crypto.randomUUID();
  // A run row is not bookkeeping: `search_coverage.run_id` is a foreign key to
  // it, so coverage cannot be claimed without one. `trigger` deliberately has
  // no CHECK constraint, which is how 'search' joined 'cli'/'ui' for free — and
  // now 'alert' joins the same way.
  //
  // `origin`/`destination` are NOT NULL scalars here and stay the route's
  // primary airports. The full pair list lives on each task's report, never in
  // a comma-joined column — see `SourceTaskReport.routes`.
  await db
    .prepare(
      `INSERT INTO search_runs
         (id, user_email, trigger, origin, destination, date_start, date_end,
          programs_json, sources_json, status, started_at, tasks_planned, host,
          runner_version, route_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'running', ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      runId,
      plan.email,
      opts.trigger,
      plan.route.origin,
      plan.route.destination,
      plan.route.date_start,
      plan.route.date_end,
      JSON.stringify([SEATSAERO_SOURCE_ID]),
      startedAt,
      plan.tasks.length,
      // The route this run is OF. `origin`/`destination` above are only its
      // primary airports, so two routes sharing a pair are otherwise
      // indistinguishable — see migrations/0008_run_route.sql.
      opts.routeId ?? plan.route.id,
    )
    .run();

  return { ok: true, runId, startedAt };
}

/**
 * Spend the calls.
 *
 * The results go into the flight database through the *same* ingest pipeline a
 * ingest uses — `recordTask` then `applyTask`, per chunk, as the search proceeds
 * — so both runners write one database under one set of coverage
 * rules, and a search that dies halfway has already stored what it found.
 *
 * `onEvent` is optional and that is the whole difference between the two callers.
 * Streaming to a person and running on a cron are the same loop; only whether
 * anyone is listening changes.
 */
export async function runSearchPass(
  db: D1Database,
  plan: SearchPlan,
  runId: string,
  opts: {
    /** Calls this pass will spend before handing back `paused`. */
    maxCalls?: number;
    /** Wall-clock stop, checked between tasks. The unattended caller passes one
     *  because a Cron Trigger's invocation is bounded and a wide route can take
     *  minutes; the HTTP caller relies on `signal` instead. */
    deadlineAt?: number;
    signal?: AbortSignal;
    onEvent?: (e: SearchEvent) => Promise<void> | void;
    captureBudgetBytes?: number;
    /** Injectable for tests; production always wants the sticky default. */
    transport?: FetchLike;
    startedAt?: number;
  } = {},
): Promise<SearchPassResult> {
  const { route, apiKey, origins, destinations, pairs, chunks, tasks, from } = plan;
  const maxCalls = opts.maxCalls ?? MAX_CALLS_PER_REQUEST;
  const startedAt = opts.startedAt ?? Date.now();
  const emit = async (e: SearchEvent) => {
    if (opts.onEvent) await opts.onEvent(e);
  };

  // ONE transport for the whole search: "the key was refused" is a fact about
  // the source, not about one chunk, and `makeTransport` is sticky — so a 401
  // on the first chunk costs one call, not five.
  const transport: FetchLike = opts.transport ?? makeTransport({ expectJson: true });

  const totals: SearchTotals = { ok: 0, failed: 0, offers: 0, written: 0, pruned: 0, calls: 0 };
  const changes: ChangeSummary[] = [];
  let lastQuota: number | undefined;
  let aborted = false;
  // Shared across chunks, so an early chunk with a huge payload doesn't leave
  // the later ones with nothing to show — it just runs the budget down.
  let captureLeft = opts.captureBudgetBytes ?? CAPTURE_BUDGET_BYTES;
  let i = from;

  try {
    await emit({
      type: "run_start",
      runId,
      origin: route.origin,
      destination: route.destination,
      chunks,
      pairs,
      total: tasks.length,
      from,
    });

    for (; i < tasks.length; i++) {
      // Stop BEFORE a task, never mid-way: a task that has started must finish
      // and be applied, or its calls are spent for nothing. The deadline is
      // checked in the same place and for the same reason.
      if (i > from && totals.calls >= maxCalls) break;
      if (i > from && opts.deadlineAt != null && Date.now() >= opts.deadlineAt) break;

      const { chunk } = tasks[i]!;
      const taskStartedAt = Date.now();
      await emit({
        type: "chunk_start",
        index: i,
        total: tasks.length,
        start: chunk.start,
        end: chunk.end,
        origins,
        destinations,
      });

      // The shape of the report is the safety property, so build it in both
      // branches rather than mutating one: a chunk that failed carries no
      // `coveredDates` AT ALL, which is what stops `applyTask` claiming
      // coverage and therefore stops it pruning real finds.
      let report: SourceTaskReport;
      let calls = 0;
      let note: string | undefined;
      // Metadata for every attempt, successful or not, so `capture_json` records
      // what was tried even when the chunk threw.
      const attempted: SeatsAeroCall[] = [];

      // Streams each call the moment it lands, so a slow page shows as
      // in-flight rather than as nothing happening.
      const onCall = async (call: SeatsAeroCall) => {
        attempted.push(call);
        await emit({ type: "call", chunkIndex: i, ...call });
      };

      try {
        const out = await runSeatsAeroChunk(chunk, {
          origin: origins,
          destination: destinations,
          apiKey,
          transport,
          signal: opts.signal,
          onCall,
          maxCaptureBytes: captureLeft,
        });
        captureLeft = Math.max(0, captureLeft - out.capturedBytes);
        calls = out.pages;
        note = out.notes.find((n) => n.includes("coverage narrowed"));
        report = {
          source: SEATSAERO_SOURCE_ID,
          taskKey: seatsAeroTaskKey(origins, destinations, chunk),
          // Real airports, never the joined list: these two land in
          // `search_tasks` as NOT NULL scalars. The pairs the call actually
          // covered — which is what coverage is claimed for — go in `routes`.
          origin: origins[0]!,
          destination: destinations[0]!,
          routes: pairs,
          dates: datesIn(chunk.start, chunk.end),
          programs: SEATSAERO_PROGRAMS,
          // Both claim coverage. `empty` is the load-bearing one: "I looked and
          // there is nothing" is a real answer and has to be storable.
          status: out.offers.length ? "ok" : "empty",
          startedAt: taskStartedAt,
          finishedAt: Date.now(),
          coveredDates: out.coveredDates,
          offers: out.offers,
          finalUrl: out.finalUrl,
          httpStatus: out.httpStatus,
          // Bodies are session-only; `capture_json` keeps the durable half.
          capture: out.calls.map(callMetadata),
        };
        if (out.quota) {
          await recordQuota(db, [out.quota]);
          if (out.quota.remaining !== lastQuota) {
            lastQuota = out.quota.remaining;
            await emit({
              type: "quota",
              remaining: out.quota.remaining,
              limit: out.quota.limit,
              observedAt: out.quota.observedAt,
            });
          }
        }
      } catch (err) {
        const { status, message } = classifyError(err);
        if (status === "timeout" && opts.signal?.aborted) aborted = true;
        report = {
          source: SEATSAERO_SOURCE_ID,
          taskKey: seatsAeroTaskKey(origins, destinations, chunk),
          origin: origins[0]!,
          destination: destinations[0]!,
          // Carried on the failure path too, and it costs nothing: `status`
          // is checked first, so a failed task claims coverage for none of
          // these pairs — exactly as it claims none for a single pair.
          routes: pairs,
          dates: datesIn(chunk.start, chunk.end),
          programs: SEATSAERO_PROGRAMS,
          status,
          startedAt: taskStartedAt,
          finishedAt: Date.now(),
          error: message,
          // No offers and — critically — no coverage claim.
          offers: [],
          // `onCall` recorded the refusal before the throw, so a blocked chunk
          // still says what it tried and what came back.
          capture: attempted.map(callMetadata),
        };
      }

      await recordTask(db, runId, report);
      const applied = await applyTask(db, runId, report);

      totals.calls += calls;
      if (report.status === "ok" || report.status === "empty") totals.ok += 1;
      else totals.failed += 1;
      totals.offers += applied.offersKept;
      totals.written += applied.snapshotsWritten;
      totals.pruned += applied.snapshotsPruned;
      changes.push(...applied.changes);

      await emit({
        type: "chunk_done",
        index: i,
        start: chunk.start,
        end: chunk.end,
        status: report.status,
        offersFound: applied.offersKept,
        snapshotsWritten: applied.snapshotsWritten,
        snapshotsPruned: applied.snapshotsPruned,
        calls,
        durationMs: report.finishedAt - report.startedAt,
        note,
        error: report.error,
      });

      // The client hung up. Everything applied so far is durable; stop
      // spending the day's allowance on a stream nobody is reading.
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
    }

    const finishedAt = Date.now();
    // Ran out of budget rather than out of work. The run stays `running` and
    // the caller is expected to ask for the rest.
    const paused = !aborted && i < tasks.length;
    // What the run row says. `running` is not a terminal state and never
    // reaches a `run_done` frame — see the `paused` branch below.
    const status = aborted
      ? ("aborted" as const)
      : paused
        ? ("running" as const)
        : runStatus(totals.ok, totals.failed, tasks.length);

    await finishRun(db, runId, { status, paused, finishedAt, totals, changes });

    // Only a run that actually claimed coverage may say the route was checked.
    // A wholly-failed search leaves `last_checked_at` alone, so the route keeps
    // reading as never searched — which is the truth.
    if (totals.ok > 0) {
      await db
        .prepare("UPDATE tracked_routes SET last_checked_at = ? WHERE id = ?")
        .bind(finishedAt, route.id)
        .run();
    }

    if (paused) {
      await emit({
        type: "run_continue",
        runId,
        nextIndex: i,
        total: tasks.length,
        calls: totals.calls,
      });
    } else {
      await emit({
        type: "run_done",
        runId,
        // `paused` is handled above, so `running` is unreachable here.
        status: status as Exclude<typeof status, "running">,
        chunksOk: totals.ok,
        chunksFailed: totals.failed,
        offersFound: totals.offers,
        snapshotsWritten: totals.written,
        snapshotsPruned: totals.pruned,
        calls: totals.calls,
        durationMs: finishedAt - startedAt,
      });
    }

    return {
      runId,
      paused,
      nextIndex: i,
      total: tasks.length,
      totals,
      changes,
      status,
    };
  } catch (err) {
    // A stream that ends with neither `run_done` nor `error` died mid-flight,
    // and the client is required to read that as failure rather than as an
    // empty result. This is the branch that keeps that promise honest.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        "UPDATE search_runs SET status = 'failed', finished_at = ?, duration_ms = ? - started_at, error = ? WHERE id = ?",
      )
      .bind(Date.now(), Date.now(), message, runId)
      .run()
      .catch(() => {});
    await emit({ type: "error", message }).catch(() => {});
    return {
      runId,
      paused: false,
      nextIndex: i,
      total: tasks.length,
      totals,
      changes,
      status: "failed",
      error: message,
    };
  }
}

