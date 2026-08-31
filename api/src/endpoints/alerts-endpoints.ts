import { Hono } from "hono";
import { type AlertRouteCost, dueRoutes, routeSweepCost, sweepPacing } from "../features/alerts/pace.js";
import { parseAlertTypes } from "../features/alerts/select.js";
import { todayISO } from "../util/dates.js";
import type { Env, Vars } from "../bindings.js";
import type { AlertSchedule } from "../../../shared/src/wire/index.js";
import { selectAlertRuns } from "../db/runs.js";
import { selectDeliveries } from "../db/alertDeliveries.js";
import { allowedRecipients } from "../features/alerts/recipients.js";
import { isLocalRequest } from "../middleware/security.js";
import { ALERT_DEFAULTS, runAlertTick } from "../features/alerts/tick.js";
import { alertRouteCosts, alertRouteRows, routeLabel } from "../features/alerts/alertRoutes.js";
import { decideSweep, readBudgetState } from "../features/alerts/scheduler-budget.js";

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

  const body: AlertSchedule = {
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
        awaitingBaseline: r.alert_last_digest_at == null,
      };
    }),
  };
  return c.json(body);
});

alerts.get("/api/alerts/runs", async (c) => {
  const limit = pageLimit(c.req.query("limit"));
  return c.json(await selectAlertRuns(c.env.DB, limit));
});

/**
 * Fire one tick by hand. **Local dev only.**
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

function pageLimit(raw: string | undefined): number {
  const n = Math.trunc(Number(raw ?? 25));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 25;
}