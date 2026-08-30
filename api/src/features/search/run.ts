import type { ChangeSummary } from "../../models/change.js";
import { planRoute, type RouteLegGroup, type RoutePair } from "../../models/route.js";
import { applyTask } from "./apply.js";
import { runStatus, type SourceQuotaObservation, type SourceTaskReport } from "../../models/task.js";
import { datesIn, planSeatsAeroChunks, runSeatsAeroChunk, SEATSAERO_PROGRAMS, SEATSAERO_SOURCE_ID, type SeatsAeroCall, type SeatsAeroChunk } from "../../providers/seatsaero.js";
import {
  classifyError,
  clientMessage,
  type FetchLike,
  makeTransport,
} from "../../providers/transport.js";
import { todayISO } from "../../util/dates.js";
import { failRun, finishRun, insertRun, selectRunForResume } from "../../db/runs.js";
import { recordQuota } from "../../db/sourceQuota.js";
import { selectSearchRoute, stampLastChecked } from "../../db/trackedRoutes.js";
import type { SearchTotals } from "../../models/run.js";
import type { SearchRouteRow } from "../../models/trackedRoute.js";

/** `MAX_STORED_CHANGES` is declared in `db/runs.ts`, beside the writer that
 *  applies it; `SearchTotals` is declared in `models/run.ts` with the rest of a
 *  run's bookkeeping. Both are re-exported here so this module reads as the
 *  search API it is. */
export { MAX_STORED_CHANGES } from "../../db/runs.js";
export type { SearchTotals } from "../../models/run.js";


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
 * callers and one behaviour** — the same idiom `applyTask` has.
 * `./endpoints.ts` streams it to a person who pressed Search;
 * `features/alerts/tick.ts` runs it unattended on a cron and reads the changes
 * it returns. Two implementations of
 * "search a route and ingest the result" would eventually disagree about
 * coverage, which is the one thing in this pipeline that silently destroys data.
 *
 * ## Three functions, not one, and the split is the safety property
 *
 * `./endpoints.ts` holds a rule that a single entry point cannot keep: **everything
 * fallible happens before the stream opens**, because once the first byte is
 * written the response is committed to 200 and an `error` frame is all that is
 * left. A missing `SEATS_AERO_API_KEY` must be a 503, never an empty result that
 * would read as "no award space".
 *
 *   1. `planSearchPass` — every refusal, as a typed code. Reads only.
 *   2. `openSearchRun`  — the first WRITE: mint or resume the `runs` row.
 *   3. `runSearchPass`  — the loop that spends calls.
 *
 * The scheduler needs them separate for a second reason: it must know what a
 * sweep will cost (`plan.chunks.length`) *before* deciding whether the day's
 * allowance can afford it, and it must not leave a `runs` row behind for
 * a sweep the budget refused. `runs.status` has a CHECK constraint with
 * no `'skipped'` in it — so the
 * ordering is forced anyway.
 */

/** What the SPA sees. Newline-delimited JSON, one object per line.
 *
 *  DEFINED IN `shared/src/wire/search.ts` and re-exported here for this
 *  module's consumers (`features/search/endpoints.ts` re-exports it again). */
export type { SearchEvent } from "../../../../shared/src/wire/search.js";
// Again as a plain import: `export … from` re-exports without binding the name
// in this module, and the run loop below is typed in terms of it.
import type { SearchEvent } from "../../../../shared/src/wire/search.js";

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
 * A Worker has a per-request subrequest budget. `include_trips` forces a
 * smaller page, so a chunk can take up to 10 of them and 5 chunks can reach 50
 * calls — a number that has to be tracked explicitly, not left to luck.
 *
 * So the search became resumable instead of capped. Every task is durable the
 * moment `applyTask` returns, so stopping between tasks costs nothing and the
 * client just asks for the rest. This also removes the wall-clock risk on a wide
 * search, which was a real failure mode waiting to happen.
 */
export const MAX_CALLS_PER_REQUEST = 25;

/** Every way a search can be refused before it spends anything.
 *
 *  A CODE rather than a status or a message, because the two callers report it
 *  differently and neither should be parsing the other's prose: `features/search/endpoints.ts` maps
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
  route: SearchRouteRow;
  apiKey: string;
  email: string;
  /** The route's own airports. The QUERIES' airports live on each group, and a
   *  hub route's differ from these — see `groups`. */
  origins: string[];
  destinations: string[];
  /** Every pair the whole search touches: the union across groups. */
  pairs: RoutePair[];
  chunks: SeatsAeroChunk[];
  /** The queries per chunk. One for a plain route, two for one with hubs. */
  groups: RouteLegGroup[];
  /**
   * One task per (chunk, group), so resuming is still an index into ONE list
   * rather than a pair of cursors.
   *
   * **Chunk-major, and the order is load-bearing.** `from` is a bare integer
   * index into this array, and `features/alerts/tick.ts` resumes from
   * `tasks_ok + tasks_failed` — a count. Reordering between passes would make a
   * resumed sweep re-run some tasks and skip others, silently.
   */
  tasks: { chunk: SeatsAeroChunk; group: RouteLegGroup }[];
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
  /** What changed, for the caller that cares. `features/search/endpoints.ts` ignores these (they
   *  are persisted to `runs.changes_json` either way); the alert sweep
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

/** `via`, which has no scalar to fall back to: NULL means "no hubs", not "use
 *  the column beside me". Distinct from `airportColumn` for the same reason
 *  `parseCodeList` is distinct from `parseCodes` in the SPA. */
function viaColumn(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
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
  const route = await selectSearchRoute(db, opts.routeId);
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
  let groups: RouteLegGroup[];
  try {
    ({ origins, destinations, pairs, groups } = planRoute(
      {
        origins: airportColumn(route.origins, route.origin),
        destinations: airportColumn(route.destinations, route.destination),
      },
      roundTrip,
      // Hubs are a SECOND query per chunk, not more airports on the same one —
      // `SFO->ICN` and `ICN->KTM` are different markets. `planRoute` owns that
      // split so the planner, the coverage claim and the cost estimate cannot
      // disagree about it.
      viaColumn(route.via),
    ));
  } catch (err) {
    // An unsearchable route is a configuration error, not an empty result.
    return { ok: false, failure: { code: "bad_route_spec", message: (err as Error).message } };
  }

  // Chunk-major: every group of a date range is done before the next range
  // starts. Both orders cost the same, and this one keeps a paused run's
  // coverage contiguous in DATE rather than leaving one direction of the whole
  // window unasked.
  const tasks = chunks.flatMap((chunk) => groups.map((group) => ({ chunk, group })));
  const from = Math.max(0, Number(opts.from ?? 0) || 0);
  if (from >= tasks.length) {
    return { ok: false, failure: { code: "nothing_to_resume", total: tasks.length } };
  }

  return {
    ok: true,
    plan: {
      route,
      apiKey,
      email: opts.email,
      origins,
      destinations,
      pairs,
      chunks,
      groups,
      tasks,
      from,
    },
  };
}

/**
 * Mint the run row, or pick up the one a paused pass left behind.
 *
 * The first write, and deliberately separate from planning: a budget-refused
 * sweep must leave no trace, and `runs.status`'s CHECK constraint has no
 * `'skipped'` to record one with.
 *
 * Resuming REUSES the run row, because its counters are where a resumed pass
 * finds its place in the plan: `tasks_ok + tasks_failed` is the index to start
 * from. A second run row would restart the search from zero.
 */
export async function openSearchRun(
  db: D1Database,
  plan: SearchPlan,
  opts: { trigger: string; resumeRunId?: string; startedAt?: number; routeId?: number },
): Promise<{ ok: true; runId: string; startedAt: number } | { ok: false; failure: PlanFailure }> {
  const startedAt = opts.startedAt ?? Date.now();

  if (opts.resumeRunId) {
    const existing = await selectRunForResume(db, opts.resumeRunId, opts.trigger);
    if (!existing) return { ok: false, failure: { code: "run_not_found" } };
    return { ok: true, runId: existing.id, startedAt };
  }

  const runId = crypto.randomUUID();
  await insertRun(db, {
    runId,
    trigger: opts.trigger,
    routeId: opts.routeId ?? plan.route.id,
    origin: plan.route.origin,
    destination: plan.route.destination,
    startedAt,
    tasksPlanned: plan.tasks.length,
  });

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
  // NOTE what is NOT destructured here: the airports and the pair list. They
  // belong to a GROUP now, not to the plan, and a hub route's two groups ask
  // different markets. Reading them plan-wide is how a task would claim coverage
  // for pairs its own call never asked about — which over-claims, and
  // over-claiming deletes real finds.
  const { route, apiKey, pairs, chunks, tasks, from } = plan;
  const maxCalls = opts.maxCalls ?? MAX_CALLS_PER_REQUEST;
  const startedAt = opts.startedAt ?? Date.now();
  const emit = async (e: SearchEvent) => {
    if (opts.onEvent) await opts.onEvent(e);
  };

  // ONE transport for the whole search: "the key was refused" is a fact about
  // the source, not about one chunk, and `makeTransport` is sticky — so a 401
  // on the first chunk costs one call, not five.
  const transport: FetchLike = opts.transport ?? makeTransport();

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

      const { chunk, group } = tasks[i]!;
      const { origins, destinations, pairs: groupPairs, role } = group;
      const taskStartedAt = Date.now();
      await emit({
        type: "chunk_start",
        index: i,
        total: tasks.length,
        start: chunk.start,
        end: chunk.end,
        origins,
        destinations,
        role,
      });

      // The shape of the report is the safety property, so build it in both
      // branches rather than mutating one: a chunk that failed carries no
      // `coveredDates` AT ALL, which is what stops `applyTask` claiming
      // coverage and therefore stops it pruning real finds.
      let report: SourceTaskReport;
      let calls = 0;
      let note: string | undefined;

      // Streams each call the moment it lands, so a slow page shows as
      // in-flight rather than as nothing happening. This is the ONLY place a
      // call is recorded: it is session state, streamed to whoever is watching,
      // and nothing durable holds it.
      const onCall = async (call: SeatsAeroCall) => {
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
          // Real airports, never the joined list: `runs` stores these as NOT
          // NULL scalars. The pairs the call actually covered — which is what
          // coverage is claimed for — go in `routes`.
          origin: origins[0]!,
          destination: destinations[0]!,
          routes: groupPairs,
          dates: datesIn(chunk.start, chunk.end),
          programs: SEATSAERO_PROGRAMS,
          // Both claim coverage. `empty` is the load-bearing one: "I looked and
          // there is nothing" is a real answer and has to be storable.
          status: out.offers.length ? "ok" : "empty",
          startedAt: taskStartedAt,
          finishedAt: Date.now(),
          coveredDates: out.coveredDates,
          offers: out.offers,
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
          origin: origins[0]!,
          destination: destinations[0]!,
          // Carried on the failure path too, and it costs nothing: `status`
          // is checked first, so a failed task claims coverage for none of
          // these pairs — exactly as it claims none for a single pair.
          routes: groupPairs,
          dates: datesIn(chunk.start, chunk.end),
          programs: SEATSAERO_PROGRAMS,
          status,
          startedAt: taskStartedAt,
          finishedAt: Date.now(),
          error: message,
          // No offers and — critically — no coverage claim.
          offers: [],
        };
      }

      const applied = await applyTask(db, report);

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
        role,
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
    if (totals.ok > 0) await stampLastChecked(db, route.id, finishedAt);

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
    // The raw message is RECORDED; a sanitised one is EMITTED. The row is read
    // by whoever is debugging and by `GET /api/alerts/runs`, and it should say
    // exactly what happened. The stream is read by a browser, where a raw D1
    // error is internal schema disclosure wearing a status message's clothes.
    const message = err instanceof Error ? err.message : String(err);
    await failRun(db, runId, Date.now(), message).catch(() => {});
    await emit({ type: "error", message: clientMessage(err) }).catch(() => {});
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

