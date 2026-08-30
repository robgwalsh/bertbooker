// From `wire/`, not `providers/seatsaero.js` — see the note in `../routing.ts`.
// Keeping this file free of the provider is what lets `SweepPacing` be part of
// the wire contract the SPA reads.
import { SEATSAERO_MAX_PAGES } from "../../../shared/src/wire/seatsaero.js";
import type { SweepPacing } from "../../../shared/src/wire/alerts.js";

/**
 * How often the scheduler may re-search the routes that ask for alerts.
 *
 * Pure. The scheduler calls this to decide what to do; `GET /api/alerts/schedule`
 * calls the SAME function to tell the user what will happen. Two implementations
 * would mean a UI that quotes a cadence the scheduler does not keep, which is a
 * worse failure than a wrong cadence — you would trust it.
 *
 * The shape of the problem: a Pro key buys 1000 seats.aero calls per UTC day, a
 * reserve is held back so a human pressing Search is never refused, and whatever
 * is left is divided among the alert-enabled routes. More routes, or wider ones,
 * means each is swept less often. That is the whole model.
 */

/** Never sweep a route more often than this, however much allowance is spare.
 *  seats.aero serves rows out of its own cache, so re-asking faster mostly
 *  re-reads the same answer and spends a call to learn nothing. It also cannot
 *  usefully sit below `SWEEP_TICK_MINUTES`: a route is only ever swept on a
 *  tick, so a finer floor would have the Alerts tab quote a cadence the cron
 *  cannot keep. */
export const MIN_SWEEP_MINUTES = 30;
/** The cron's period, MIRRORED from `[triggers] crons` in `api/wrangler.toml` —
 *  change one and change the other. A route is only ever swept on a tick, so
 *  this is the resolution of every cadence below; `dueGraceMs` is why that has
 *  to be written down rather than inferred from `MIN_SWEEP_MINUTES`, which
 *  happens to be the same number today and answers a different question. */
export const SWEEP_TICK_MINUTES = 30;
/** ...and never claim a cadence slower than daily; past that the honest answer
 *  is "this is unaffordable", which is a different return value. */
export const MAX_SWEEP_MINUTES = 24 * 60;

/** Back-off multiplier ceiling. Eight failed sweeps in a row is already a route
 *  that needs a person, not a faster retry. */
const MAX_BACKOFF_SHIFT = 3;

export interface AlertRouteCost {
  routeId: number;
  /** Date chunks the route plans — `planSeatsAeroChunks(...).length`. Zero means
   *  the window has fallen entirely into the past, which is a route that cannot
   *  be swept at all rather than a free one. */
  chunks: number;
  /**
   * seats.aero QUERIES per chunk: 1 for a plain route, 2 for one with hubs.
   *
   * The unit of cost is the TASK — one (chunk, query) pair — and it stopped
   * being the chunk when a route gained hubs, because `SFO->ICN` and `ICN->KTM`
   * are different markets and cannot ride in one call. Optional and defaulting
   * to 1 so a caller that has not been taught about hubs is merely as wrong as
   * it was before, rather than newly broken.
   */
  groups?: number;
  /** What the route's last sweep actually spent (`runs.calls`), when one
   *  has run. Undefined on a route that has never been swept. */
  observedCalls?: number;
}

/** Tasks one full sweep plans. The unit `routeSweepCost` counts in, and the
 *  number `runs.tasks_planned` holds. */
export function routeSweepTasks(route: AlertRouteCost): number {
  if (route.chunks <= 0) return 0;
  return route.chunks * Math.max(1, route.groups ?? 1);
}

/**
 * What one sweep of this route should be budgeted at.
 *
 * The direction of the guess matters more than its accuracy.
 * `estimateSearchCalls` quotes a range — one call per TASK at the floor, ten
 * times that if every task paginates out — and the two ends are a factor of ten
 * apart. Guessing low overspends the day's allowance; guessing high sweeps less
 * often than it could. So: **pessimistic while ignorant, measured once measured.**
 *
 * `max(observed, floor)` rather than `observed` alone because a paused sweep
 * records only the calls that pass spent, and a route resumed across three ticks
 * would otherwise look a third as expensive as it is.
 *
 * Both ends count tasks rather than chunks. A hub route plans twice the tasks
 * for the same window, and counting its chunks would budget it at half what it
 * spends — which is guessing low, the one direction this is built not to.
 */
export function routeSweepCost(route: AlertRouteCost): number {
  const tasks = routeSweepTasks(route);
  if (tasks <= 0) return 0;
  if (route.observedCalls == null) return tasks * SEATSAERO_MAX_PAGES;
  return Math.max(route.observedCalls, tasks);
}

// Declared in `../wire/alerts.ts` beside `AlertSchedulePacing`, the flattened
// form of it that goes over the wire, and re-exported here so `sweepPacing()`
// below and its callers are unchanged.
export type { SweepPacing } from "../../../shared/src/wire/alerts.js";

/**
 * Divide the day's alert allowance among the routes that want it.
 *
 * The unaffordable case is a RETURN VALUE, not a clamp. `floor(budget / cost)`
 * is zero the moment one cycle costs more than a day's allowance, and dividing
 * by that yields Infinity — which would clamp silently to the daily maximum and
 * present a route that cannot be afforded as one that is merely slow. The user
 * would then wait a day for an email that was never going to arrive. Saying so
 * is the only honest option, and the Alerts tab renders it.
 */
export function sweepPacing(args: {
  routes: AlertRouteCost[];
  dailyBudget: number;
  minMinutes?: number;
  maxMinutes?: number;
}): SweepPacing {
  const minMinutes = args.minMinutes ?? MIN_SWEEP_MINUTES;
  const maxMinutes = args.maxMinutes ?? MAX_SWEEP_MINUTES;

  // A zero-chunk route is excluded from the cost model AND from the due set. It
  // contributes nothing to spend because it cannot spend anything: its window
  // has expired, every sweep would refuse before the first call, and counting it
  // as free would let it drag the cadence of the routes that do work.
  const unsearchable = args.routes.filter((r) => r.chunks <= 0).map((r) => r.routeId);
  const searchable = args.routes.filter((r) => r.chunks > 0);

  const cycleCost = searchable.reduce((sum, r) => sum + routeSweepCost(r), 0);

  if (searchable.length === 0) {
    return { affordable: false, reason: "no_routes", cycleCost: 0, dailyBudget: args.dailyBudget, unsearchable };
  }
  if (cycleCost > args.dailyBudget) {
    return {
      affordable: false,
      reason: "cycle_exceeds_budget",
      cycleCost,
      dailyBudget: args.dailyBudget,
      unsearchable,
    };
  }

  const cyclesPerDay = Math.floor(args.dailyBudget / cycleCost);
  const intervalMinutes = Math.min(
    maxMinutes,
    Math.max(minMinutes, Math.ceil((24 * 60) / cyclesPerDay)),
  );
  return { affordable: true, intervalMinutes, cycleCost, cyclesPerDay, unsearchable };
}

/**
 * What `alert_last_digest_at` should become when a route's alerts are switched
 * ON — `now` to arm it immediately, or `null` to spend the next sweep on a
 * silent baseline.
 *
 * **The baseline is the stored snapshot, not this clock.** `diffAvailability`
 * compares a sweep's results against the per-source snapshot already in the
 * database; the digest clock only decides whether the resulting changes are
 * allowed to be emailed. So the question is not "has this route been swept by
 * the scheduler" but "is there a recent enough snapshot to diff against" — and a
 * route somebody searched by hand ten minutes ago already has one. Clearing the
 * clock there spends a route's full call cost to compute a diff against fresh
 * data and then throws the answer away, and makes the user wait another whole
 * interval for the first email.
 *
 * The cutoff is `MAX_SWEEP_MINUTES` because that is the slowest cadence the
 * pacer will ever claim: data fresher than that is no staler than what a normal
 * alert cycle diffs against, so accepting it grants nothing the scheduler does
 * not already do to itself. Older than that and the wall-of-`new` problem in
 * §5 of docs/ALERTS.md is real again.
 *
 * Known edge, deliberately not handled: `last_checked_at` is one timestamp for
 * the whole route, so a search that covered only part of the window looks as
 * fresh as one that covered all of it. Widening a window and enabling alerts in
 * the same breath can still produce one noisy digest. Bounding it properly would
 * mean recording per-slice check times, which is a whole stored table for one
 * avoidable email — the trade that got that table deleted.
 */
export function baselineOnEnable(
  lastCheckedAt: number | null | undefined,
  now: number,
  maxAgeMinutes: number = MAX_SWEEP_MINUTES,
): number | null {
  if (lastCheckedAt == null) return null;
  return now - lastCheckedAt <= maxAgeMinutes * 60_000 ? now : null;
}

export interface AlertRouteClock {
  routeId: number;
  chunks: number;
  /** The PACING clock — written on every attempt, success or failure. Null on a
   *  route that has never been swept, which makes it maximally overdue. */
  alertLastAttemptAt: number | null;
  /** Written only by a run that claimed coverage. Consulted as a FLOOR: a route
   *  a person searched by hand two minutes ago holds fresh data, and re-spending
   *  on it because the alert clock happened to come due is waste. */
  lastCheckedAt: number | null;
  consecutiveFailures: number;
}

/**
 * Is this route due, and how overdue?
 *
 * Both clocks are consulted and they answer different questions. The attempt
 * clock stops a failing route from hot-looping — `last_checked_at` is never
 * written when a run fails, so pacing off it alone would make a broken route due
 * on every single tick and spend the whole day's allowance discovering the same
 * failure. The checked clock stops a *working* route being re-swept moments
 * after a person searched it by hand.
 *
 * Back-off is on the attempt clock only: a route that keeps failing waits
 * `interval × 2^failures`, capped, so a route whose window quietly expired costs
 * one sweep a day rather than one every tick.
 */
export function routeDueAt(route: AlertRouteClock, intervalMinutes: number): number {
  const interval = intervalMinutes * 60_000;
  const backoff = 2 ** Math.min(route.consecutiveFailures, MAX_BACKOFF_SHIFT);
  const fromAttempt =
    route.alertLastAttemptAt == null ? 0 : route.alertLastAttemptAt + interval * backoff;
  const fromChecked = route.lastCheckedAt == null ? 0 : route.lastCheckedAt + interval;
  return Math.max(fromAttempt, fromChecked);
}

/**
 * How early a tick may take a route as due.
 *
 * **A route is only ever swept ON a tick**, so the cron's period is the
 * resolution of every cadence here, and demanding that the interval be strictly
 * elapsed rounds each wait up to the next tick *plus one more* whenever the due
 * time lands a hair past it. That is measured, not hypothetical: four routes the
 * Alerts tab paced at `every 15m` were swept every 30 minutes, exactly, for as
 * long as `runs` records.
 *
 * The hair is the sweeper's own write. `alert_last_attempt_at` is stamped with
 * the tick's clock, but `last_checked_at` — which `routeDueAt` takes as a floor —
 * is written when the search FINISHES, measured at 1.3 to 4.6 seconds later. The
 * cron is regular to the millisecond (900,001 ms between the two ticks that
 * wrote those rows), so `lastChecked + interval` lands just *after* the next tick
 * every single time: not due, skipped, swept on the one after.
 *
 * Half a tick of grace makes a route due on the tick NEAREST its due time rather
 * than the first tick strictly after it. It cannot sweep anything early in
 * practice, because there is no tick between one sweep and its successor to be
 * early on. Bounded by half the interval as well, so this stays true if the cron
 * period and `MIN_SWEEP_MINUTES` ever stop being the same number.
 */
function dueGraceMs(intervalMinutes: number): number {
  return (Math.min(SWEEP_TICK_MINUTES, intervalMinutes) / 2) * 60_000;
}

/**
 * The routes to sweep now, most overdue first.
 *
 * An unsearchable route (no chunks) is never due — it would refuse at
 * `planSearchPass` and burn a tick to learn what the plan already knows.
 */
export function dueRoutes(
  routes: AlertRouteClock[],
  intervalMinutes: number,
  now: number,
): AlertRouteClock[] {
  const grace = dueGraceMs(intervalMinutes);
  return routes
    .filter((r) => r.chunks > 0)
    .map((r) => ({ route: r, dueAt: routeDueAt(r, intervalMinutes) }))
    .filter(({ dueAt }) => dueAt - grace <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map(({ route }) => route);
}
