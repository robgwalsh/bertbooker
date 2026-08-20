import { type DigestRoute, groupForRecipients, renderDigest } from "../alerts/digest.js";
import { type AlertRouteCost, dueRoutes, routeSweepCost, sweepPacing } from "../alerts/pace.js";
import { parseAlertTypes, selectAlertable } from "../alerts/select.js";
import type { ChangeSummary } from "../domain/diff.js";
import { PORTAL_CURRENCIES } from "../domain/programs.js";
import { planSeatsAeroChunks } from "../providers/seatsaero.js";
import { queryGroupCount } from "../domain/routing.js";
import { todayISO } from "../providers/window.js";
import type { Env } from "../bindings.js";
import { ROUTE_FINDS_MATCH, ROUTE_FINDS_SEATS, findsCte } from "../db/finds.js";
import { idempotencyKey, sendEmail } from "./email.js";
import { openSearchRun, planSearchPass, runSearchPass } from "../search/run.js";
import { decideSweep, readBudgetState } from "./budget.js";

/**
 * The scheduled sweep — the only unattended work in this codebase.
 *
 * Read `docs/ALERTS.md` before changing anything here, and
 * `migrations/0007_alerts.sql` for why this exists at all despite four comments
 * elsewhere forbidding it. The short version is that both objections were real
 * and both are answered rather than ignored: the budget guard returns scoped to
 * this file's caller (`./budget.ts`), and every sweep is an ordinary
 * `search_runs` row visible in the Alerts tab, because no email is ever sent
 * about a failure.
 *
 * ## Why one route per tick
 *
 * A Cron Trigger with an interval under one hour gets **30 seconds of CPU**
 * (an hourly one would get 15 minutes). Waiting on seats.aero is I/O and costs
 * no CPU, but parsing does — a page is up to 500 rows carrying trips, measured
 * at ~9.9 KB each. So a tick sweeps one route, capped at
 * `ALERT_MAX_CALLS_PER_TICK`, and a route needing more resumes on the next tick
 * through the same `run_continue` mechanism the HTTP search uses.
 *
 * ## Why there is an outbox
 *
 * "One digest per sweep cycle" and "one route per tick" only coexist if a change
 * outlives the tick that found it. Changes land in `alert_outbox` and the digest
 * flushes when the cycle is complete — no route due, none mid-run. A tick that
 * dies therefore loses nothing.
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

export interface AlertRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  date_start: string;
  date_end: string;
  cabins: string | null;
  min_seats: number;
  round_trip: number;
  /** Hubs, which double the queries per chunk — see `routeSweepCost`. */
  via: string | null;
  alert_email: string | null;
  alert_on: string | null;
  alert_min_drop_pct: number;
  alert_last_attempt_at: number | null;
  alert_last_digest_at: number | null;
  alert_consecutive_failures: number;
  last_checked_at: number | null;
  /** What this route's last completed sweep actually spent. */
  observed_calls: number | null;
}

function parseList(json: string | null, fallback?: string): string[] {
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
    } catch {
      /* fall through */
    }
  }
  return fallback ? [fallback] : [];
}

/**
 * Every alert-enabled route, with the two things pacing needs alongside it: how
 * long since it was attempted, and what its last completed sweep actually spent.
 *
 * `observed_calls` is read off `search_runs.calls` for THIS route
 * (`route_id`, added in 0008 — the `origin`/`destination` scalars are only the
 * route's primary airports, so two routes sharing a pair would otherwise be
 * priced off each other's measurements).
 */
export async function alertRouteRows(env: Env, email: string): Promise<AlertRouteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT tr.id, tr.origin, tr.destination, tr.origins, tr.destinations,
            tr.date_start, tr.date_end, tr.cabins, tr.min_seats, tr.round_trip,
            tr.via,
            tr.alert_email, tr.alert_on, tr.alert_min_drop_pct,
            tr.alert_last_attempt_at, tr.alert_last_digest_at,
            tr.alert_consecutive_failures, tr.last_checked_at,
            (SELECT hr.calls FROM search_runs hr
              WHERE hr.route_id = tr.id AND hr.trigger = 'alert'
                AND hr.finished_at IS NOT NULL
              ORDER BY hr.started_at DESC LIMIT 1) AS observed_calls
       FROM tracked_routes tr
      WHERE tr.user_email = ? AND tr.alerts_enabled = 1
      ORDER BY tr.id`,
  )
    .bind(email)
    .all<AlertRouteRow>();
  return results ?? [];
}

/**
 * What each route costs a sweep, keyed by id.
 *
 * ONE implementation with two callers — the scheduler and the Alerts tab —
 * because `docs/ALERTS.md` §4 is explicit that a page quoting a cadence the
 * scheduler does not keep is worse than no number at all. It used to be a bare
 * chunk count duplicated in both; hubs made the cost `chunks × queries` and gave
 * the duplication somewhere new to drift.
 */
export function alertRouteCosts(
  rows: readonly AlertRouteRow[],
  today: string,
): Map<number, AlertRouteCost> {
  return new Map(
    rows.map((r) => [
      r.id,
      {
        routeId: r.id,
        chunks: planSeatsAeroChunks(r.date_start, r.date_end, today).length,
        groups: queryGroupCount(
          {
            origins: parseList(r.origins, r.origin),
            destinations: parseList(r.destinations, r.destination),
          },
          r.round_trip === 1,
          parseList(r.via),
        ),
        observedCalls: r.observed_calls == null ? undefined : Number(r.observed_calls),
      },
    ]),
  );
}

/** `SEA/PDX → NRT/HND` — the route's identity is its shape, which is what both
 *  surfaces that list routes already show. */
export function routeLabel(r: AlertRouteRow): string {
  const o = parseList(r.origins, r.origin).join("/");
  const d = parseList(r.destinations, r.destination).join("/");
  return `${o} ${r.round_trip === 1 ? "⇄" : "→"} ${d}`;
}

/** Defined in `shared/src/wire/alerts.ts` — the SPA reads it as
 *  `AlertTickResult`. Re-exported here so this module's consumers are
 *  unchanged. */
export type { TickResult } from "../../../shared/src/wire/alerts.js";
import type { TickResult } from "../../../shared/src/wire/alerts.js";

/**
 * One cron tick.
 *
 * Deliberately returns a summary rather than throwing on a route's failure: a
 * single unsearchable route must not stop the rest of the cycle, and its
 * failure is already durable on its own `search_runs` row.
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
  // this. Unset means there is no account to attribute a run to and
  // `search_runs.user_email` is NOT NULL — fail closed and quietly, exactly as
  // the gate would.
  if (!email) {
    result.pacing = "no_app_user_email";
    return result;
  }

  const routes = await alertRouteRows(env, email);
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

  // ---- sweep at most one route ------------------------------------------
  // See the docblock: 30 seconds of CPU is the constraint, and one route's worth
  // of JSON parsing is what spends it.
  let target: AlertRouteRow | undefined;
  if (opts.force !== undefined) {
    target = byId.get(opts.force);
    if (!target) {
      // Not an alert route (or not this account's). Reported rather than thrown,
      // so the caller reads one channel for every reason a tick did nothing.
      result.skipped.push({ routeId: opts.force, reason: "not_alert_route" });
    } else if (chunksOf(target.id) <= 0) {
      // `dueRoutes` would have filtered this; forcing must not route around the
      // reason. `planSearchPass` refuses an expired window, and letting it get
      // that far would bump `alert_consecutive_failures` and back the route off
      // for a fault that is not the sweeper's.
      result.skipped.push({ routeId: target.id, reason: "window_expired" });
      target = undefined;
    }
  } else if (pacing.affordable) {
    const due = dueRoutes(
      routes.map((r) => ({
        routeId: r.id,
        chunks: chunksOf(r.id),
        alertLastAttemptAt: r.alert_last_attempt_at,
        lastCheckedAt: r.last_checked_at,
        consecutiveFailures: r.alert_consecutive_failures,
      })),
      pacing.intervalMinutes,
      now,
    );
    target = due[0] ? byId.get(due[0].routeId) : undefined;
  }

  if (target) {
    const cost = routeSweepCost({
      routeId: target.id,
      chunks: chunksOf(target.id),
      groups: costFor.get(target.id)?.groups,
      observedCalls: target.observed_calls == null ? undefined : Number(target.observed_calls),
    });
    const budget = await readBudgetState(env.DB, now);
    const decision = decideSweep({ ...budget, estimatedCost: cost, reserve, dailyBudget });

    if (!decision.go) {
      // No run row: `search_runs.status` has no 'skipped', and a row that never
      // spent anything would pollute the pacing measurements it feeds.
      result.skipped.push({ routeId: target.id, reason: decision.reason });
    } else {
      await sweepRoute(env, target, { now, maxCalls: maxCallsPerTick, deadlineAt: opts.deadlineAt });
      result.sweptRouteIds.push(target.id);
    }
  }

  // ---- flush, if the cycle is complete -----------------------------------
  // `cycleComplete` is defined in terms of the interval, and an unaffordable set
  // has none. Only reachable when forced, and a forced sweep out of that state
  // is filing into the outbox for a cycle that does not exist — it flushes once
  // the pacing problem is fixed.
  if (pacing.affordable && (await cycleComplete(env, email, pacing.intervalMinutes, now))) {
    result.flushed = await flushOutbox(env, email, now);
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
 */
async function sweepRoute(
  env: Env,
  route: AlertRouteRow,
  opts: { now: number; maxCalls: number; deadlineAt?: number },
): Promise<void> {
  const email = env.APP_USER_EMAIL!;

  // The pacing clock is stamped on every ATTEMPT, before anything can fail.
  // Stamping it only on success would let a permanently-failing route be due on
  // every single tick and spend the day rediscovering the same failure.
  await env.DB.prepare("UPDATE tracked_routes SET alert_last_attempt_at = ? WHERE id = ?")
    .bind(opts.now, route.id)
    .run();

  // A paused sweep left a run to resume; picking it up is what keeps one route's
  // coverage on one run row.
  const open = await env.DB.prepare(
    `SELECT id, tasks_planned, tasks_ok, tasks_failed FROM search_runs
      WHERE route_id = ? AND trigger = 'alert' AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(route.id)
    .first<{ id: string; tasks_planned: number; tasks_ok: number; tasks_failed: number }>();

  const planned = await planSearchPass(env.DB, {
    email,
    routeId: route.id,
    apiKey: env.SEATS_AERO_API_KEY,
    from: open ? (open.tasks_ok ?? 0) + (open.tasks_failed ?? 0) : 0,
  });
  if (!planned.ok) {
    await noteFailure(env, route.id);
    return;
  }

  const opened = await openSearchRun(env.DB, planned.plan, {
    trigger: "alert",
    resumeRunId: open?.id,
    routeId: route.id,
  });
  if (!opened.ok) {
    await noteFailure(env, route.id);
    return;
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
    return;
  }
  await env.DB.prepare("UPDATE tracked_routes SET alert_consecutive_failures = 0 WHERE id = ?")
    .bind(route.id)
    .run();

  // A paused route is only half-searched. Filing its changes now would let the
  // flush describe half a route as though it were the whole answer.
  if (pass.paused) return;

  if (route.alert_last_digest_at == null) {
    // Baseline. Ingest kept, nothing filed, clock stamped.
    await env.DB.prepare("UPDATE tracked_routes SET alert_last_digest_at = ? WHERE id = ?")
      .bind(opts.now, route.id)
      .run();
    return;
  }

  const alertable = selectAlertable(
    pass.changes,
    await routeFindKeys(env, route),
    {
      types: parseAlertTypes(route.alert_on),
      minDropPct: route.alert_min_drop_pct ?? 0,
    },
    { cabins: parseList(route.cabins), minSeats: route.min_seats },
  );
  if (alertable.length) await fileOutbox(env, route.id, opened.runId, alertable, opts.now);
}

async function noteFailure(env: Env, routeId: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE tracked_routes SET alert_consecutive_failures = alert_consecutive_failures + 1 WHERE id = ?",
  )
    .bind(routeId)
    .run();
}

/**
 * The `changeKey`s that survive THIS route's own filters.
 *
 * One query, and it is the same SQL the dashboard's join uses
 * (`ROUTE_FINDS_MATCH`) — so an alert can never fire on a find the route's own
 * pane would hide. Re-implementing the cabin/currency/nonstop rules in
 * TypeScript would have been a fourth copy of a rule CLAUDE.md already warns is
 * duplicated, and the only copy blind to the cross-source collapse.
 */
async function routeFindKeys(env: Env, route: AlertRouteRow): Promise<Set<string>> {
  const cte = findsCte({ where: [], binds: [] });
  const { results } = await env.DB.prepare(
    `${cte.sql}
     SELECT f.route_key, f.program, f.cabin
       FROM finds f
       JOIN tracked_routes tr ON tr.id = ?
        AND ${ROUTE_FINDS_MATCH}
      WHERE ${ROUTE_FINDS_SEATS}`,
  )
    .bind(...cte.binds, route.id, JSON.stringify(PORTAL_CURRENCIES))
    .all<{ route_key: string; program: string; cabin: string }>();

  // Must match `changeKey` in api/src/domain/diff.ts exactly.
  return new Set((results ?? []).map((r) => `${r.route_key}|${r.program}|${r.cabin}`));
}

/** File changes for the next digest. Newest wins on conflict: a route swept
 *  twice before a flush must not report the same seat twice, and the later
 *  observation is the true one. */
async function fileOutbox(
  env: Env,
  routeId: number,
  runId: string,
  changes: ChangeSummary[],
  now: number,
): Promise<void> {
  const stmts = changes.map((c) =>
    env.DB.prepare(
      `INSERT INTO alert_outbox
         (route_id, change_key, type, origin, destination, flight_date, program,
          cabin, miles_cost, seats, prev_miles, prev_seats, detected_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (route_id, change_key) DO UPDATE SET
         type = excluded.type, miles_cost = excluded.miles_cost,
         seats = excluded.seats, prev_miles = excluded.prev_miles,
         prev_seats = excluded.prev_seats, detected_at = excluded.detected_at,
         run_id = excluded.run_id`,
    ).bind(
      routeId,
      c.key,
      c.type,
      c.origin ?? "",
      c.destination ?? "",
      c.flightDate,
      c.program,
      c.cabin,
      c.milesCost ?? null,
      c.seatsAvailable ?? null,
      c.previousMilesCost ?? null,
      c.previousSeats ?? null,
      now,
      runId,
    ),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

/** Is the cycle over — nothing due, nothing mid-run? Only then does a digest
 *  describe a complete pass rather than an arbitrary slice of one. */
async function cycleComplete(
  env: Env,
  email: string,
  intervalMinutes: number,
  now: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tracked_routes
         WHERE user_email = ? AND alerts_enabled = 1
           AND (alert_last_attempt_at IS NULL OR alert_last_attempt_at <= ?)) AS due,
       (SELECT COUNT(*) FROM search_runs
         WHERE trigger = 'alert' AND status = 'running') AS running`,
  )
    .bind(email, now - intervalMinutes * 60_000)
    .first<{ due: number; running: number }>();
  return (row?.due ?? 0) === 0 && (row?.running ?? 0) === 0;
}

/**
 * Send what is waiting, one digest per recipient.
 *
 * Every outcome is recorded in `alert_deliveries`, including the ones where
 * nothing was sent. No failure email exists, so that table is the only trace a
 * dropped digest leaves — and "we never tried" must not read the same as "they
 * refused".
 */
async function flushOutbox(env: Env, email: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT o.*, tr.alert_email, tr.origin, tr.destination, tr.origins, tr.destinations,
            tr.round_trip
       FROM alert_outbox o
       JOIN tracked_routes tr ON tr.id = o.route_id
      WHERE tr.user_email = ?
      ORDER BY o.route_id, o.flight_date`,
  )
    .bind(email)
    .all<Record<string, unknown>>();
  if (!results?.length) return 0;

  const perRoute = new Map<number, DigestRoute>();
  const runIds = new Set<string>();
  for (const row of results) {
    const routeId = Number(row.route_id);
    runIds.add(String(row.run_id));
    let entry = perRoute.get(routeId);
    if (!entry) {
      entry = {
        routeId,
        label: routeLabel(row as unknown as AlertRouteRow),
        recipient: (row.alert_email as string | null) ?? email,
        changes: [],
      };
      perRoute.set(routeId, entry);
    }
    entry.changes.push({
      type: String(row.type) as ChangeSummary["type"],
      key: String(row.change_key),
      flightDate: String(row.flight_date),
      program: String(row.program),
      cabin: String(row.cabin),
      origin: String(row.origin ?? ""),
      destination: String(row.destination ?? ""),
      milesCost: row.miles_cost == null ? undefined : Number(row.miles_cost),
      seatsAvailable: row.seats == null ? undefined : Number(row.seats),
      previousMilesCost: row.prev_miles == null ? undefined : Number(row.prev_miles),
      previousSeats: row.prev_seats == null ? undefined : Number(row.prev_seats),
    });
  }

  // Routes swept this cycle with nothing to say are named in the digest rather
  // than omitted — "three checked, two quiet" and "only one ran" are different
  // facts and no failure email exists to tell them apart.
  const quiet = await env.DB.prepare(
    `SELECT tr.* FROM tracked_routes tr
      WHERE tr.user_email = ? AND tr.alerts_enabled = 1
        AND tr.alert_last_digest_at IS NOT NULL
        AND tr.id NOT IN (SELECT route_id FROM alert_outbox)`,
  )
    .bind(email)
    .all<AlertRouteRow>();

  const digestRoutes: DigestRoute[] = [
    ...perRoute.values(),
    ...(quiet.results ?? []).map((r) => ({
      routeId: r.id,
      label: routeLabel(r),
      recipient: r.alert_email ?? email,
      changes: [],
    })),
  ];

  const sweepId = crypto.randomUUID();
  const grouped = groupForRecipients(digestRoutes, env.APP_URL);
  let sent = 0;

  for (const [recipient, input] of grouped) {
    const rendered = renderDigest(input);
    const outcome = await sendEmail(env, {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: await idempotencyKey(sweepId, recipient),
    });
    const changeCount = input.groups.reduce((n, g) => n + g.changes.length, 0);
    await env.DB.prepare(
      `INSERT INTO alert_deliveries
         (sweep_id, to_email, status, subject, change_count, route_ids_json,
          run_ids_json, provider_message_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sweep_id, to_email) DO NOTHING`,
    )
      .bind(
        sweepId,
        recipient,
        outcome.status,
        rendered.subject,
        changeCount,
        JSON.stringify(input.groups.map((g) => g.routeId)),
        JSON.stringify([...runIds]),
        outcome.status === "sent" ? (outcome.providerMessageId ?? null) : null,
        outcome.status === "sent" ? null : outcome.error,
      )
      .run();

    if (outcome.status === "sent") {
      sent += 1;
      // Only clear what we actually told someone about. A refused send leaves
      // the outbox intact so the next cycle tries again rather than losing it.
      const ids = input.groups.map((g) => g.routeId);
      if (ids.length) {
        await env.DB.prepare(
          `DELETE FROM alert_outbox WHERE route_id IN (${ids.map(() => "?").join(",")})`,
        )
          .bind(...ids)
          .run();
        await env.DB.prepare(
          `UPDATE tracked_routes SET alert_last_digest_at = ?
            WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
          .bind(now, ...ids)
          .run();
      }
    }
  }
  return sent;
}
