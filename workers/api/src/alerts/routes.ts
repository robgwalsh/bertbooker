import { Hono } from "hono";
import {
  dueRoutes,
  parseAlertTypes,
  planSeatsAeroChunks,
  routeSweepCost,
  sweepPacing,
  todayISO,
  type AlertRouteCost,
} from "@bertbooker/core";
import type { Env, Vars } from "../bindings.js";
import { allowedRecipients } from "../email.js";
import { isLocalRequest } from "../security.js";
import { ALERT_DEFAULTS, alertRouteRows, routeLabel, runAlertTick } from "./sweep.js";
import { decideSweep, readBudgetState } from "./budget.js";

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
  const email = c.get("userEmail");
  const now = Date.now();
  const rows = await alertRouteRows(c.env, email);
  const cfg = ALERT_DEFAULTS(c.env);

  const today = todayISO();
  const chunksFor = new Map<number, number>();
  const costs: AlertRouteCost[] = rows.map((r) => {
    const chunks = planSeatsAeroChunks(r.date_start, r.date_end, today).length;
    chunksFor.set(r.id, chunks);
    return {
      routeId: r.id,
      chunks,
      observedCalls: r.observed_calls == null ? undefined : Number(r.observed_calls),
    };
  });

  const pacing = sweepPacing({ routes: costs, dailyBudget: cfg.dailyBudget });
  const intervalMinutes = pacing.affordable ? pacing.intervalMinutes : null;

  const due = intervalMinutes
    ? new Set(
        dueRoutes(
          rows.map((r) => ({
            routeId: r.id,
            chunks: chunksFor.get(r.id) ?? 0,
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

  return c.json({
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
      allowedRecipients: allowedRecipients(c.env),
    },
    routes: rows.map((r) => {
      const chunks = chunksFor.get(r.id) ?? 0;
      return {
        id: r.id,
        label: routeLabel(r),
        chunks,
        // Zero chunks means the window has fallen entirely into the past. Such a
        // route is excluded from the cost model AND never due — it would refuse
        // at planning and burn a tick to learn what the plan already knows — so
        // it is surfaced by name rather than left looking merely idle.
        windowExpired: chunks === 0,
        estimatedCalls: routeSweepCost({
          routeId: r.id,
          chunks,
          observedCalls: r.observed_calls == null ? undefined : Number(r.observed_calls),
        }),
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
  });
});

/** Recent sweeps. `search_runs` already answers this; the filter is the only
 *  new part: a sweep is a `search_runs` row like any other, told apart only
 *  by its trigger. */
alerts.get("/api/alerts/runs", async (c) => {
  const email = c.get("userEmail");
  const limit = Math.min(Number(c.req.query("limit") ?? 25) || 25, 100);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM search_runs
      WHERE user_email = ? AND trigger = 'alert'
      ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(email, limit)
    .all();
  return c.json(results ?? []);
});

/**
 * Fire one tick by hand. **Local dev only.**
 *
 * The cron is the only caller in production and that does not change; this is
 * the development loop. Without it, working on `alerts/` means waiting up to
 * fifteen minutes for a tick, up to `intervalMinutes` for that tick to pick your
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
  const limit = Math.min(Number(c.req.query("limit") ?? 25) || 25, 100);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM alert_deliveries ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all();
  return c.json(results ?? []);
});
