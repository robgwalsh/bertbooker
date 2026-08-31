import { Hono } from "hono";
import { type AlertRouteCost, dueRoutes, routeSweepCost, sweepPacing } from "./pace.js";
import { parseAlertTypes } from "./select.js";
import { todayISO } from "../../util/dates.js";
import type { Env, Vars } from "../../bindings.js";
import type { AlertSchedule } from "../../../../shared/src/wire/index.js";
import { selectAlertRuns } from "../../db/runs.js";
import { selectDeliveries } from "../../db/alertDeliveries.js";
import { allowedRecipients } from "./recipients.js";
import { isLocalRequest } from "../../middleware/security.js";
import { ALERT_DEFAULTS, runAlertTick } from "./tick.js";
import { alertRouteCosts, alertRouteRows, routeLabel } from "./alertRoutes.js";
import { decideSweep, readBudgetState } from "./scheduler-budget.js";

/**
 * What the Alerts tab reads, and — in local dev only — the one control it has.
 *
 * The reads are not a convenience. The app sends **no email when a sweep
 * fails** — only when it finds something — so the Alerts tab is the only surface
 * on which a broken scheduler is distinguishable from a quiet one, and this is
 * what fills it. That is the answer to the objection recorded in
 * `wrangler.toml`: unattended work hides source failures *unless something is
 * built to show them*.
 *
 * Everything derived here goes through the SAME pure functions the scheduler
 * calls (`sweepPacing`, `dueRoutes`, `routeSweepCost`, `decideSweep`). A second
 * implementation would produce a page that quotes a cadence the scheduler does
 * not keep, and a wrong number you trust is worse than no number. `POST /run`
 * holds that line the hard way: it calls `runAlertTick` itself rather than
 * reimplementing a tick, so there is nothing it can test that production does
 * not do.
 */
export const alerts = new Hono<{ Bindings: Env; Variables: Vars }>();

alerts.get("/api/alerts/schedule", async (c) => {
  // The account address, and here only as the fallback RECIPIENT a route with
  // no `alert_email` of its own would be mailed at. Nothing is scoped by it.
  const email = c.get("userEmail");
  const now = Date.now();
  const rows = await alertRouteRows(c.env);
  const cfg = ALERT_DEFAULTS(c.env);

  const today = todayISO();
  // The SAME cost function the scheduler prices with. docs/ALERTS.md §4: a page
  // quoting a cadence the sweeper does not keep is worse than no number.
  const costFor = alertRouteCosts(rows, today);
  const costs: AlertRouteCost[] = [...costFor.values()];

  const pacing = sweepPacing({ routes: costs, dailyBudget: cfg.dailyBudget });
  const intervalMinutes = pacing.affordable ? pacing.intervalMinutes : null;

  const due = intervalMinutes
    ? new Set(
        dueRoutes(
          rows.map((r) => ({
            routeId: r.id,
            chunks: costFor.get(r.id)?.chunks ?? 0,
            alertLastAttemptAt: r.alert_last_attempt_at,
            lastCheckedAt: r.last_checked_at,
            consecutiveFailures: r.alert_consecutive_failures,
          })),
          intervalMinutes,
          now,
        ).map((r) => r.routeId),
      )
    : new Set<number>();

  const budget = await readBudgetState(c.env.DB, now);
  // Priced against the whole cycle, because that is what the next full pass
  // costs — a per-route answer would say "affordable" for each of five routes
  // that together are not.
  const decision = decideSweep({
    ...budget,
    estimatedCost: pacing.affordable ? pacing.cycleCost : 0,
    reserve: cfg.reserve,
    dailyBudget: cfg.dailyBudget,
  });

  // Annotated, and this is the endpoint that most needed it. This literal used
  // to be the ONLY description of the response anywhere on the server — the
  // SPA's `AlertSchedule` interface was the only written-down form of it, and
  // nothing compared the two. All fourteen mapped route fields below are now
  // checked against what the Alerts tab reads.
  const body: AlertSchedule = {
    // Whether `POST /api/alerts/run` exists on this host. Answered here rather
    // than by making the SPA probe for a 404, because the page already fetches
    // this and a button that appears only to fail is worse than no button.
    manualTick: isLocalRequest(c.req.url),
    pacing: {
      ...pacing,
      // Named separately so the UI never has to re-derive "is this on".
      intervalMinutes,
    },
    budget: {
      dailyBudget: cfg.dailyBudget,
      reserve: cfg.reserve,
      maxCallsPerTick: cfg.maxCallsPerTick,
      selfSpentToday: budget.selfSpentToday,
      observedRemaining: budget.observation?.remaining ?? null,
      // "observed" vs "self_accounted" is worth showing: early in a UTC day
      // nothing has reported a number and the guard is reasoning from our own
      // records instead. See budget.ts.
      basis: decision.basis,
      wouldSweepNow: decision.go,
      blockedReason: decision.go ? null : decision.reason,
    },
    email: {
      configured: Boolean(c.env.RESEND_API_KEY && c.env.ALERT_FROM),
      from: c.env.ALERT_FROM ?? null,
      allowedRecipients: await allowedRecipients(c.env),
    },
    routes: rows.map((r) => {
      const cost = costFor.get(r.id);
      const chunks = cost?.chunks ?? 0;
      return {
        id: r.id,
        label: routeLabel(r),
        chunks,
        // Zero chunks means the window has fallen entirely into the past. Such a
        // route is excluded from the cost model AND never due — it would refuse
        // at planning and burn a tick to learn what the plan already knows — so
        // it is surfaced by name rather than left looking merely idle.
        windowExpired: chunks === 0,
        queriesPerChunk: cost?.groups ?? 1,
        estimatedCalls: cost ? routeSweepCost(cost) : 0,
        observedCalls: r.observed_calls == null ? null : Number(r.observed_calls),
        alertOn: parseAlertTypes(r.alert_on),
        alertMinDropPct: r.alert_min_drop_pct,
        recipient: r.alert_email ?? email,
        lastAttemptAt: r.alert_last_attempt_at,
        lastDigestAt: r.alert_last_digest_at,
        lastCheckedAt: r.last_checked_at,
        consecutiveFailures: r.alert_consecutive_failures,
        due: due.has(r.id),
        // A route that has never sent a digest will perform a silent BASELINE
        // sweep first. Saying so stops "I turned it on and got nothing" reading
        // as a fault.
        awaitingBaseline: r.alert_last_digest_at == null,
      };
    }),
  };
  return c.json(body);
});

/**
 * A `?limit=` from the query string, as a row count this app will actually run.
 *
 * Clamped at BOTH ends, which the two call sites below were not: they wrote
 * `Math.min(Number(q) || 25, 100)`, and `-1` is a perfectly truthy number that
 * survives `Math.min` — so `?limit=-1` reached SQLite as `LIMIT -1`, which
 * SQLite defines as NO LIMIT. Both endpoints are `SELECT *` over tables that
 * grow with every sweep, and D1 bills rows read, so the low end is the end that
 * mattered.
 *
 * `Math.trunc` as well, so `?limit=1e9` and `?limit=2.5` cannot become anything
 * but an integer inside the range.
 */
function pageLimit(raw: string | undefined): number {
  const n = Math.trunc(Number(raw ?? 25));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 25;
}

/** Recent sweeps. `runs` already answers this; the filter is the only
 *  new part: a sweep is a `runs` row like any other, told apart only
 *  by its trigger. */
alerts.get("/api/alerts/runs", async (c) => {
  const limit = pageLimit(c.req.query("limit"));
  return c.json(await selectAlertRuns(c.env.DB, limit));
});

/**
 * Fire one tick by hand. **Local dev only.**
 *
 * The cron is the only caller in production and that does not change; this is
 * the development loop. Without it, working on `alerts/` means waiting up to
 * thirty minutes for a tick, up to `intervalMinutes` for that tick to pick your
 * route, and then reading D1 by hand to find out what it decided.
 *
 * Three properties, each load-bearing:
 *
 * - **It is `runAlertTick`, not a copy of it.** Anything this can exercise, the
 *   cron does identically — which is the only thing that makes it worth testing
 *   through.
 * - **It returns the whole `TickResult`.** A tick that swept nothing has to say
 *   why, or this becomes one more surface on which a broken sweep and a quiet
 *   one look the same. That is the failure mode the entire feature is built
 *   against; see docs/ALERTS.md §1.
 * - **`routeId` bypasses cadence, never the budget guard.** Pacing decides how
 *   often, and waiting on it is exactly what this endpoint is for. `decideSweep`
 *   decides whether the calls can be paid for, runs unchanged inside
 *   `runAlertTick`, and will refuse a forced sweep like any other.
 *
 * 404 rather than 403 off-host: in production this should be indistinguishable
 * from a route that was never written. It sits behind `gate` regardless — the
 * host check decides what a developer can reach, not who is let in.
 */
alerts.post("/api/alerts/run", async (c) => {
  if (!isLocalRequest(c.req.url)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ routeId?: number }>().catch(() => ({}) as { routeId?: number });
  // Unvalidated on purpose: an id that is not an alert route comes back as
  // `skipped: [{ reason: "not_alert_route" }]`, so every reason a tick did
  // nothing arrives on one channel instead of splitting across status codes.
  return c.json(await runAlertTick(c.env, { force: body.routeId }));
});

/** Every digest we tried to send, including the ones that never went out. With
 *  no failure email, this table is the only trace a dropped digest leaves. */
alerts.get("/api/alerts/deliveries", async (c) => {
  const limit = pageLimit(c.req.query("limit"));
  return c.json(await selectDeliveries(c.env.DB, limit));
});
