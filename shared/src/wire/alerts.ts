// The scheduled sweep's two responses. See docs/ALERTS.md.
//
// `AlertSchedule` is the one wire shape that had NO written-down form anywhere
// until this module: `GET /api/alerts/schedule` builds a four-level object
// literal by hand in `api/src/endpoints/alerts.ts`, and the SPA's interface was the
// only description of it. Annotating that handler against this type is the
// highest-value half of the whole enforcement pass — it is 14 mapped route
// fields that nothing was checking.

import type { AlertType } from "./domain.js";

/**
 * What one full pass over every alert-enabled route costs, and how often it can
 * therefore run.
 *
 * Declared here rather than beside `sweepPacing()` (which computes it, in
 * `api/src/alerts/pace.ts` and re-exports this type) because the Alerts tab
 * renders the answer: `AlertSchedulePacing` below is the flattened form that
 * actually goes over the wire, and this is the union it is spread from.
 */
export type SweepPacing =
  | {
      affordable: true;
      /** Minutes between sweeps of any one route. */
      intervalMinutes: number;
      /** Calls one full pass over every alert route is expected to spend. */
      cycleCost: number;
      cyclesPerDay: number;
      /** Routes that cannot be swept — window entirely in the past. */
      unsearchable: number[];
    }
  | {
      affordable: false;
      /** Why, in a form the Alerts tab can render without re-deriving it. */
      reason: "no_routes" | "cycle_exceeds_budget";
      cycleCost: number;
      dailyBudget: number;
      unsearchable: number[];
    };

/** `GET /api/alerts/schedule`. */
export interface AlertSchedule {
  /** Whether `POST /api/alerts/run` exists on this host — true under
   *  `wrangler dev`, false in production. The gate on every manual-tick
   *  control; see `alertRunTick`. */
  manualTick: boolean;
  pacing: AlertSchedulePacing;
  budget: AlertScheduleBudget;
  email: AlertScheduleEmail;
  routes: AlertScheduleRoute[];
}

/**
 * The cadence readout.
 *
 * A FLAT BAG, not the `SweepPacing` discriminated union it is built from. The
 * handler spreads that union and adds `intervalMinutes`, and both of its arms
 * spread cleanly into this shape — so this is an exact description of what goes
 * over the wire, which a union would not be. Narrowing it to
 * `SweepPacing & { intervalMinutes }` would be more precise and is deliberately
 * not done here; the wire is what the wire is.
 */
export interface AlertSchedulePacing {
  affordable: boolean;
  intervalMinutes: number | null;
  cycleCost: number;
  /** Present when unaffordable: 'no_routes' | 'cycle_exceeds_budget'. */
  reason?: string;
  cyclesPerDay?: number;
  dailyBudget?: number;
  unsearchable: number[];
}

/** What `alerts/budget.ts` will let the next tick spend. The ONE place that
 *  reads the quota before spending — every interactive path spends first and
 *  reports after. */
export interface AlertScheduleBudget {
  dailyBudget: number;
  reserve: number;
  maxCallsPerTick: number;
  selfSpentToday: number;
  observedRemaining: number | null;
  /** 'observed' | 'self_accounted' — early in a UTC day nothing has reported
   *  a number and the guard reasons from our own records instead. */
  basis: string;
  wouldSweepNow: boolean;
  blockedReason: string | null;
}

export interface AlertScheduleEmail {
  configured: boolean;
  from: string | null;
  allowedRecipients: string[];
}

export interface AlertScheduleRoute {
  id: number;
  label: string;
  chunks: number;
  /**
   * seats.aero queries per date chunk: 1 normally, 2 for a route with hubs.
   *
   * Carried so `estimatedCalls` still FOLLOWS from what the page shows. Cost is
   * `chunks × this × pages`, and without it a hub route quotes twice the calls
   * its visible chunk count explains — a number that looks like a bug in the
   * page rather than the price of a second market.
   */
  queriesPerChunk: number;
  /** The window has fallen entirely into the past — the route cannot be swept
   *  at all, which is different from merely idle. */
  windowExpired: boolean;
  estimatedCalls: number;
  observedCalls: number | null;
  alertOn: AlertType[];
  alertMinDropPct: number;
  recipient: string;
  lastAttemptAt: number | null;
  lastDigestAt: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  due: boolean;
  /** The next sweep will be a SILENT baseline — see docs/ALERTS.md. */
  awaitingBaseline: boolean;
}

/**
 * `POST /api/alerts/run` — the whole of what one tick decided.
 *
 * Reported in full rather than summarised to an `ok`, because a tick that swept
 * nothing has to be able to say why: `pacing` and `skipped` are the difference
 * between "nothing was due" and "the budget guard refused", which look identical
 * from `sweptRouteIds` alone. The SPA reads this as `AlertTickResult`.
 */
export interface TickResult {
  sweptRouteIds: number[];
  /** Reasons a route was passed over: 'reserve' | 'exhausted' (budget guard),
   *  'not_alert_route' | 'window_expired' (a forced id that cannot be swept). */
  skipped: { routeId: number; reason: string }[];
  /** Digests sent, once the cycle completed. Usually 0. */
  flushed: number;
  /** `every Nm`, or the reason there is no cadence at all
   *  ('no_alert_routes' | 'no_app_user_email' | 'cycle_exceeds_budget' | 'no_routes'). */
  pacing: string;
}
