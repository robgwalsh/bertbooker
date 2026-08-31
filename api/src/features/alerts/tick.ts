import { dueRoutes, routeSweepCost, sweepPacing } from "./pace.js";
import { parseAlertTypes, selectAlertable } from "./select.js";
import { alertRouteCosts, alertRouteRows, parseList, type AlertRouteRow } from "./alertRoutes.js";
import { cycleComplete, flushOutbox, pruneOldRuns } from "./outbox.js";
import { decideSweep, readBudgetState } from "./scheduler-budget.js";
import { changeKey } from "../../models/change.js";
import { todayISO } from "../../util/dates.js";
import type { Cabin } from "../../models/availability.js";
import type { Env } from "../../bindings.js";
import { selectMatchableFinds } from "../../db/finds.js";
import {
  bumpAlertFailures,
  clearAlertFailures,
  stampAlertAttempt,
  stampAlertDigest,
} from "../../db/trackedRoutes.js";
import { selectResumableAlertRun } from "../../db/runs.js";
import { insertOutboxChanges } from "../../db/alertOutbox.js";
import { routeMatcher } from "../../../../shared/src/match/routeMatch.js";
import { openSearchRun, planSearchPass, runSearchPass } from "../search/run.js";

/**
 * The cron tick — the scheduling half of the sweep, and the only unattended work
 * in this codebase.
 *
 * Read `docs/ALERTS.md` before changing anything here. The two standing
 * objections to unattended spending are answered rather than ignored: the budget
 * guard is scoped to this file's caller (`./budget.ts`) and lives nowhere else,
 * and every sweep is an ordinary `runs` row visible in the Alerts tab, because
 * no email is ever sent about a failure.
 *
 * What a tick DECIDES is here; what it eventually SAYS is `./outbox.ts`.
 *
 * ## Why a tick is bounded in CALLS, not in routes
 *
 * A Cron Trigger with an interval under one hour gets **30 seconds of CPU**
 * (an hourly one would get 15 minutes). Waiting on seats.aero is I/O and costs
 * no CPU, but parsing does — a page is up to 500 rows carrying trips, measured
 * at ~9.9 KB each. So the tick's ceiling is `ALERT_MAX_CALLS_PER_TICK`, and a
 * route needing more resumes on the next tick through the same `run_continue`
 * mechanism the HTTP search uses.
 *
 * This used to sweep **one route** per tick, which read as the same bound and
 * was not. Calls are what cost CPU; routes are a proxy that is only right when a
 * route costs a whole tick's worth. Four narrow routes cost one call each, so
 * the tick spent 1 of its 25 and the set round-robined at four times the cadence
 * `sweepPacing` claimed — measured at 96 calls a day against a 600 budget, with
 * the Alerts tab quoting `every 15m` for a set actually swept hourly. Worse, the
 * digest never flushed: `cycleComplete` wants every route attempted inside one
 * interval, and one-route-per-tick cannot deliver that for more than one route.
 *
 * **The ceiling did not move.** A single route could already spend all 25 calls
 * in one tick, so sweeping four routes for four calls is strictly less work than
 * the shape already permitted. What changed is that the budget stops going
 * unused. Raising `ALERT_MAX_CALLS_PER_TICK` itself is still the thing that
 * needs the cron interval raised first.
 */

const DEFAULT_DAILY_BUDGET = 600;
const DEFAULT_MANUAL_RESERVE = 300;
const DEFAULT_MAX_CALLS_PER_TICK = 25;

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The tunables, resolved once. Shared with `routes.ts` so the Alerts tab
 *  cannot quote a budget the scheduler is not using. */
export const ALERT_DEFAULTS = (env: Env) => ({
  dailyBudget: num(env.ALERT_DAILY_BUDGET, DEFAULT_DAILY_BUDGET),
  reserve: num(env.ALERT_MANUAL_RESERVE, DEFAULT_MANUAL_RESERVE),
  maxCallsPerTick: num(env.ALERT_MAX_CALLS_PER_TICK, DEFAULT_MAX_CALLS_PER_TICK),
});

/** Defined in `shared/src/wire/alerts.ts` — the SPA reads it as
 *  `AlertTickResult`. Re-exported here so this module's consumers are
 *  unchanged. */
export type { TickResult } from "../../../../shared/src/wire/alerts.js";
import type { TickResult } from "../../../../shared/src/wire/alerts.js";

/**
 * One cron tick.
 *
 * Deliberately returns a summary rather than throwing on a route's failure: a
 * single unsearchable route must not stop the rest of the cycle, and its
 * failure is already durable on its own `runs` row.
 *
 * `opts.force` is the local-dev lever behind `POST /api/alerts/run` — sweep this
 * route id whether or not it is due. It bypasses **cadence and nothing else**:
 * the due filter and the pacing-affordability return are both answers to "how
 * often", and waiting four hours to find out whether a code change works is the
 * whole reason that endpoint exists. `decideSweep` still runs, unchanged and in
 * the same place, because it answers "can this be paid for" — a different
 * question, and the one the reinstated budget guard was for. A forced sweep also
 * stamps `alert_last_attempt_at` like any other, so it does move the route's
 * clock; that is correct, since it really did spend the calls.
 */
export async function runAlertTick(
  env: Env,
  opts: { now?: number; deadlineAt?: number; force?: number } = {},
): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const email = env.APP_USER_EMAIL;
  const result: TickResult = { sweptRouteIds: [], skipped: [], flushed: 0, pacing: "" };

  // `scheduled()` runs no middleware, so there is no `identity` to have done
  // this. Unset means there is no address a digest could be sent to — fail
  // closed and quietly, exactly as the gate would.
  if (!email) {
    result.pacing = "no_app_user_email";
    return result;
  }

  const routes = await alertRouteRows(env);
  if (routes.length === 0) {
    result.pacing = "no_alert_routes";
    return result;
  }

  const today = todayISO();
  const costFor = alertRouteCosts(routes, today);
  const chunksOf = (id: number) => costFor.get(id)?.chunks ?? 0;

  const { dailyBudget, reserve, maxCallsPerTick } = ALERT_DEFAULTS(env);

  const pacing = sweepPacing({ routes: [...costFor.values()], dailyBudget });
  if (!pacing.affordable && opts.force === undefined) {
    // Not a clamp and not a throw. An unaffordable set is a real state the
    // Alerts tab renders; sweeping anyway would spend the reserve a manual
    // search depends on.
    result.pacing = pacing.reason;
    return result;
  }
  // Reported either way, so a forced sweep out of `cycle_exceeds_budget` still
  // names the state it was forced out of rather than presenting itself as normal.
  result.pacing = pacing.affordable ? `every ${pacing.intervalMinutes}m` : pacing.reason;

  const byId = new Map(routes.map((r) => [r.id, r] as const));

  // ---- sweep the due routes, until the tick's CALL budget is spent -------
  // See the docblock: 30 seconds of CPU is the constraint and parsing pages is
  // what spends it, so the bound is `maxCallsPerTick` rather than a route count.
  // A route that alone costs the whole tick still gets the whole tick, exactly
  // as before; a set of narrow ones no longer leaves 24 of 25 calls unspent.
  let targets: AlertRouteRow[] = [];
  if (opts.force !== undefined) {
    // Forcing is deliberately still ONE route: the endpoint's argument is a
    // route id, and "sweep this and tell me what happens" is the whole question
    // it exists to answer.
    const forced = byId.get(opts.force);
    if (!forced) {
      // Not an alert route (or not this account's). Reported rather than thrown,
      // so the caller reads one channel for every reason a tick did nothing.
      result.skipped.push({ routeId: opts.force, reason: "not_alert_route" });
    } else if (chunksOf(forced.id) <= 0) {
      // `dueRoutes` would have filtered this; forcing must not route around the
      // reason. `planSearchPass` refuses an expired window, and letting it get
      // that far would bump `alert_consecutive_failures` and back the route off
      // for a fault that is not the sweeper's.
      result.skipped.push({ routeId: forced.id, reason: "window_expired" });
    } else {
      targets = [forced];
    }
  } else if (pacing.affordable) {
    // Most overdue first, so a tick that runs out of calls part-way through
    // starves the route that has waited least rather than an arbitrary one.
    targets = dueRoutes(
      routes.map((r) => ({
        routeId: r.id,
        chunks: chunksOf(r.id),
        alertLastAttemptAt: r.alert_last_attempt_at,
        lastCheckedAt: r.last_checked_at,
        consecutiveFailures: r.alert_consecutive_failures,
      })),
      pacing.intervalMinutes,
      now,
    ).flatMap((d) => byId.get(d.routeId) ?? []);
  }

  let callsLeft = maxCallsPerTick;
  for (const target of targets) {
    if (callsLeft <= 0) break;
    // Honour a deadline the caller set between routes as well as between tasks.
    // `scheduled()` passes none today — `maxCalls` is what bounds a real tick —
    // but a loop that ignored one it was handed would be its own bug.
    if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) break;

    const cost = routeSweepCost({
      routeId: target.id,
      chunks: chunksOf(target.id),
      groups: costFor.get(target.id)?.groups,
      observedCalls: target.observed_calls == null ? undefined : Number(target.observed_calls),
    });
    // Re-read per route rather than once per tick: `finishRun` has written the
    // previous route's `calls` by now, so self-accounting stays honest as the
    // tick spends, and the reserve is measured against what is actually left.
    const budget = await readBudgetState(env.DB, now);
    const decision = decideSweep({ ...budget, estimatedCost: cost, reserve, dailyBudget });

    if (!decision.go) {
      // No run row: `runs.status` has no 'skipped', and a row that never
      // spent anything would pollute the pacing measurements it feeds.
      result.skipped.push({ routeId: target.id, reason: decision.reason });
      // The guard's answer is about the day, not this route, so nothing later in
      // the tick can pass a test this one just failed for less.
      if (decision.reason === "exhausted") break;
      continue;
    }

    // A paused route consumed everything left and the loop ends on the next
    // iteration's `callsLeft` check — no special case needed.
    const spent = await sweepRoute(env, target, {
      now,
      maxCalls: callsLeft,
      deadlineAt: opts.deadlineAt,
    });
    callsLeft -= spent;
    result.sweptRouteIds.push(target.id);
  }

  // ---- flush, if the cycle is complete -----------------------------------
  // `cycleComplete` is defined in terms of the interval, and an unaffordable set
  // has none. Only reachable when forced, and a forced sweep out of that state
  // is filing into the outbox for a cycle that does not exist — it flushes once
  // the pacing problem is fixed.
  if (pacing.affordable && (await cycleComplete(env, pacing.intervalMinutes, now))) {
    result.flushed = await flushOutbox(env, email, now);
    // The one place anything deletes a run row. Bounded by design: this is the
    // only table in the app that grows on a clock rather than with the data, and
    // every read of it (the Alerts tab, the pacing lookup, the budget guard's
    // SUM) gets cheaper for it. Once per completed cycle, not per tick.
    await pruneOldRuns(env, now);
  }
  return result;
}

/**
 * Search one route and file whatever it should alert about.
 *
 * The first sweep of a route files NOTHING, and that is the single most
 * important line here. `diffAvailability` compares against the last snapshot for
 * that source, so a route that has not been searched recently classifies
 * everything it finds as `new` plus a wall of `gone` — thousands of changes, cut
 * to `MAX_STORED_CHANGES`, emailed as a meaningless 200-of-3000 digest. A route
 * with no `alert_last_digest_at` therefore ingests normally, files nothing, and
 * just stamps the clock. The same rule covers a route whose alerts were switched
 * back on after going dark.
 *
 * Returns the calls it actually spent, which is what the tick decrements its
 * budget by. A route that never reached `runSearchPass` — a refused plan, a run
 * that would not open — spent nothing and is reported as nothing, so a tick is
 * not shortened by a route that failed for free.
 */
async function sweepRoute(
  env: Env,
  route: AlertRouteRow,
  opts: { now: number; maxCalls: number; deadlineAt?: number },
): Promise<number> {
  const email = env.APP_USER_EMAIL!;

  // The pacing clock is stamped on every ATTEMPT, before anything can fail.
  // Stamping it only on success would let a permanently-failing route be due on
  // every single tick and spend the day rediscovering the same failure.
  await stampAlertAttempt(env.DB, route.id, opts.now);

  // A paused sweep left a run to resume; picking it up is what keeps one route's
  // coverage on one run row.
  const open = await selectResumableAlertRun(env.DB, route.id);

  const planned = await planSearchPass(env.DB, {
    email,
    routeId: route.id,
    apiKey: env.SEATS_AERO_API_KEY,
    from: open ? (open.tasks_ok ?? 0) + (open.tasks_failed ?? 0) : 0,
  });
  if (!planned.ok) {
    await noteFailure(env, route.id);
    return 0;
  }

  const opened = await openSearchRun(env.DB, planned.plan, {
    trigger: "alert",
    resumeRunId: open?.id,
    routeId: route.id,
  });
  if (!opened.ok) {
    await noteFailure(env, route.id);
    return 0;
  }

  const pass = await runSearchPass(env.DB, planned.plan, opened.runId, {
    maxCalls: opts.maxCalls,
    deadlineAt: opts.deadlineAt,
    // Nobody is watching, and holding megabytes of captured JSON to throw away
    // is pure CPU against a 30-second budget.
    captureBudgetBytes: 0,
  });

  if (pass.totals.ok === 0) {
    await noteFailure(env, route.id);
    return pass.totals.calls;
  }
  await clearAlertFailures(env.DB, route.id);

  // A paused route is only half-searched. Filing its changes now would let the
  // flush describe half a route as though it were the whole answer.
  if (pass.paused) return pass.totals.calls;

  if (route.alert_last_digest_at == null) {
    // Baseline. Ingest kept, nothing filed, clock stamped.
    await stampAlertDigest(env.DB, route.id, opts.now);
    return pass.totals.calls;
  }

  const alertable = selectAlertable(
    pass.changes,
    await routeFindKeys(env, route),
    {
      types: parseAlertTypes(route.alert_on),
      minDropPct: route.alert_min_drop_pct ?? 0,
    },
    {
      cabins: parseList(route.cabins),
      minSeats: route.min_seats,
      pointLimit: route.point_limit ?? null,
    },
  );
  if (alertable.length) await insertOutboxChanges(env.DB, route.id, alertable);
  return pass.totals.calls;
}

async function noteFailure(env: Env, routeId: number): Promise<void> {
  await bumpAlertFailures(env.DB, routeId);
}

/**
 * The `changeKey`s that survive THIS route's own filters.
 *
 * The same predicate the Routes page applies — `routeMatcher`, out of
 * `shared/src/match/routeMatch.ts` — so an alert can never fire on a find the
 * route's own pane would hide. That sharing is the load-bearing part and it is
 * why the predicate is one module rather than one copy each: the sweep sends no
 * mail when it finds nothing, so a drift in that direction reports itself to
 * nobody.
 *
 * **Scoped to this one route**, which is the whole reason this function stopped
 * being the most expensive statement in the app: it used to pass an empty
 * `FindsScope`, so it collapsed every snapshot of every route to answer about
 * one — 171,471 rows read for a route whose entire input was 23. `AlertRouteRow`
 * carries every column `routeFindsScope` AND `routeMatcher` need, so this costs
 * no extra query.
 *
 * Nine columns, not the twenty-one the Routes page projects: the answer is a
 * membership set, and everything else this used to compute was thrown away.
 * Which nine is `selectMatchableFinds`' business now; what stays here is the
 * matcher and the key-building it feeds.
 */
async function routeFindKeys(env: Env, route: AlertRouteRow): Promise<Set<string>> {
  const results = await selectMatchableFinds(env.DB, route);

  const matcher = routeMatcher(route);
  const keys = new Set<string>();
  for (const f of results) {
    if (!matcher.matches(f)) continue;
    // `changeKey` itself, not a copy of its format: this set is intersected
    // against keys the diff produced, so the two spellings must be one.
    keys.add(
      changeKey({
        origin: f.origin,
        destination: f.destination,
        flightDate: f.flight_date,
        program: f.program,
        cabin: f.cabin as Cabin,
      }),
    );
  }
  return keys;
}
