import { describe, expect, it } from "vitest";
import {
  MAX_SWEEP_MINUTES,
  MIN_SWEEP_MINUTES,
  SWEEP_TICK_MINUTES,
  baselineOnEnable,
  dueRoutes,
  routeDueAt,
  routeSweepCost,
  sweepPacing,
} from "./pace.js";

const MIN = 60_000;

/**
 * The pacing model: what a route costs a sweep, how often the set can be swept
 * for that, which routes are due now, and what turning alerts on does to the
 * digest clock.
 *
 * All pure, which is the point — `docs/ALERTS.md` §4 requires the scheduler and
 * the Alerts tab to call the SAME functions, because a page quoting a cadence
 * the sweeper does not keep is worse than no number at all. These are those
 * functions.
 */

describe("routeSweepCost", () => {
  it("is pessimistic while ignorant — a never-swept route is priced at the CEILING", () => {
    // The floor would be 5. Guessing low is the direction that overspends the
    // day's allowance, so an unmeasured route is priced at chunks * MAX_PAGES.
    expect(routeSweepCost({ routeId: 1, chunks: 5 })).toBe(50);
  });

  it("uses the measured cost once a sweep has run", () => {
    expect(routeSweepCost({ routeId: 1, chunks: 5, observedCalls: 12 })).toBe(12);
  });

  it("never prices a route below its chunk count", () => {
    // A paused sweep records only the calls THAT pass spent. Believing it would
    // make a route resumed across three ticks look a third as expensive as it is.
    expect(routeSweepCost({ routeId: 1, chunks: 5, observedCalls: 2 })).toBe(5);
  });


  it("counts TASKS, not chunks — a hub route plans two queries per range", () => {
    // Counting its chunks would budget a hub route at half what it spends, which
    // is guessing low: the one direction this is built not to.
    expect(routeSweepCost({ routeId: 1, chunks: 5, groups: 2 })).toBe(100);
    expect(routeSweepCost({ routeId: 1, chunks: 5, groups: 2, observedCalls: 4 })).toBe(10);
  });

  it("treats an absent group count as one, so an untaught caller is merely as wrong as before", () => {
    expect(routeSweepCost({ routeId: 1, chunks: 5, groups: 1 })).toBe(
      routeSweepCost({ routeId: 1, chunks: 5 }),
    );
  });

  it("prices an expired window at zero — it cannot spend anything", () => {
    expect(routeSweepCost({ routeId: 1, chunks: 0, observedCalls: 40 })).toBe(0);
  });
});

describe("sweepPacing", () => {
  it("reports no_routes rather than an interval when nothing wants alerts", () => {
    const p = sweepPacing({ routes: [], dailyBudget: 600 });
    expect(p.affordable).toBe(false);
    if (!p.affordable) expect(p.reason).toBe("no_routes");
  });

  it("REFUSES rather than clamping when one cycle costs more than a day", () => {
    // The bug this pins: floor(600/700) is 0, 1440/0 is Infinity, and Infinity
    // clamps silently to the daily maximum — presenting an unaffordable set as
    // merely slow, so you wait a day for an email that was never coming.
    const p = sweepPacing({
      routes: [{ routeId: 1, chunks: 5 }, { routeId: 2, chunks: 5 }, { routeId: 3, chunks: 5 }],
      dailyBudget: 100,
    });
    expect(p.affordable).toBe(false);
    if (!p.affordable) {
      expect(p.reason).toBe("cycle_exceeds_budget");
      expect(p.cycleCost).toBe(150);
    }
  });

  it("divides the allowance among the routes", () => {
    // One route measured at 10 calls, 300 budget => 30 cycles/day => every 48m,
    // clear of the floor so this pins the division rather than the clamp.
    const p = sweepPacing({
      routes: [{ routeId: 1, chunks: 5, observedCalls: 10 }],
      dailyBudget: 300,
    });
    expect(p.affordable).toBe(true);
    if (p.affordable) {
      expect(p.cyclesPerDay).toBe(30);
      expect(p.intervalMinutes).toBe(48);
    }
  });

  it("floors at MIN_SWEEP_MINUTES however much allowance is spare", () => {
    const p = sweepPacing({
      routes: [{ routeId: 1, chunks: 1, observedCalls: 1 }],
      dailyBudget: 1000,
    });
    expect(p.affordable).toBe(true);
    if (p.affordable) expect(p.intervalMinutes).toBe(MIN_SWEEP_MINUTES);
  });

  it("excludes an expired-window route from the cost model and names it", () => {
    const p = sweepPacing({
      routes: [
        { routeId: 1, chunks: 5, observedCalls: 10 },
        { routeId: 2, chunks: 0 },
      ],
      dailyBudget: 600,
    });
    expect(p.affordable).toBe(true);
    if (p.affordable) {
      expect(p.cycleCost).toBe(10);
      expect(p.unsearchable).toEqual([2]);
    }
  });

  it("is unaffordable when every route has expired", () => {
    const p = sweepPacing({ routes: [{ routeId: 1, chunks: 0 }], dailyBudget: 600 });
    expect(p.affordable).toBe(false);
    if (!p.affordable) expect(p.reason).toBe("no_routes");
  });
});

describe("routeDueAt / dueRoutes", () => {
  const base = { routeId: 1, chunks: 5, consecutiveFailures: 0 };

  it("makes a never-swept route maximally overdue", () => {
    expect(
      routeDueAt({ ...base, alertLastAttemptAt: null, lastCheckedAt: null }, 60),
    ).toBe(0);
  });

  it("paces off the ATTEMPT clock, so a failing route cannot hot-loop", () => {
    // last_checked_at is never written by a failing run. Pacing off it alone
    // would make a broken route due on every tick and spend the day proving it.
    const at = 1_000_000;
    expect(
      routeDueAt({ ...base, alertLastAttemptAt: at, lastCheckedAt: null }, 60),
    ).toBe(at + 60 * MIN);
  });

  it("also respects last_checked_at as a floor", () => {
    // Searched by hand a moment ago: the data is fresh, so don't re-spend.
    const attempt = 1_000_000;
    const checked = 5_000_000;
    expect(
      routeDueAt({ ...base, alertLastAttemptAt: attempt, lastCheckedAt: checked }, 60),
    ).toBe(checked + 60 * MIN);
  });

  it("backs off exponentially on consecutive failures, capped", () => {
    const at = 1_000_000;
    const clock = (f: number) => ({
      ...base,
      consecutiveFailures: f,
      alertLastAttemptAt: at,
      lastCheckedAt: null,
    });
    expect(routeDueAt(clock(1), 60)).toBe(at + 120 * MIN);
    expect(routeDueAt(clock(3), 60)).toBe(at + 480 * MIN);
    // Capped — eight failures in a row needs a person, not a faster retry.
    expect(routeDueAt(clock(9), 60)).toBe(at + 480 * MIN);
  });

  it("never returns an expired-window route as due", () => {
    const routes = [
      { routeId: 1, chunks: 0, alertLastAttemptAt: null, lastCheckedAt: null, consecutiveFailures: 0 },
      { routeId: 2, chunks: 5, alertLastAttemptAt: null, lastCheckedAt: null, consecutiveFailures: 0 },
    ];
    expect(dueRoutes(routes, 60, 9_000_000).map((r) => r.routeId)).toEqual([2]);
  });

  it("is due on the tick NEAREST its due time, not the one after", () => {
    // The 2x slowdown, in the shape the live database recorded it. The tick
    // stamps `alert_last_attempt_at` with its own clock and the search writes
    // `last_checked_at` when it finishes, a few seconds later; the cron is
    // regular to the millisecond. So the floor lands just past the next tick and
    // a route paced at 15 minutes was swept every 30.
    const attempt = 1_000_000;
    const checked = attempt + 3_000;
    const nextTick = attempt + SWEEP_TICK_MINUTES * MIN;
    const route = {
      routeId: 1,
      chunks: 5,
      alertLastAttemptAt: attempt,
      lastCheckedAt: checked,
      consecutiveFailures: 0,
    };

    // The due time really is past the tick — the grace is what closes it, not a
    // change to the clocks.
    expect(routeDueAt(route, SWEEP_TICK_MINUTES)).toBeGreaterThan(nextTick);
    expect(dueRoutes([route], SWEEP_TICK_MINUTES, nextTick).map((r) => r.routeId)).toEqual([1]);
  });

  it("does not pull a longer cadence forward by a whole tick", () => {
    // The grace is half a TICK, so a 60-minute cadence still waits for the
    // 60-minute mark. Half an INTERVAL here would have swept it at 30.
    const attempt = 1_000_000;
    const route = {
      routeId: 1,
      chunks: 5,
      alertLastAttemptAt: attempt,
      lastCheckedAt: null,
      consecutiveFailures: 0,
    };
    expect(dueRoutes([route], 60, attempt + 30 * MIN)).toEqual([]);
    expect(dueRoutes([route], 60, attempt + 60 * MIN).map((r) => r.routeId)).toEqual([1]);
  });

  it("orders the due set most-overdue first", () => {
    const now = 10_000_000;
    const mk = (routeId: number, attempt: number) => ({
      routeId,
      chunks: 5,
      alertLastAttemptAt: attempt,
      lastCheckedAt: null,
      consecutiveFailures: 0,
    });
    const out = dueRoutes([mk(1, now - 2 * 60 * MIN), mk(2, now - 10 * 60 * MIN)], 60, now);
    expect(out.map((r) => r.routeId)).toEqual([2, 1]);
  });
});

describe("baselineOnEnable", () => {
  const NOW = 1_700_000_000_000;

  it("suppresses the first digest for a route nobody has searched", () => {
    expect(baselineOnEnable(null, NOW)).toBeNull();
    expect(baselineOnEnable(undefined, NOW)).toBeNull();
  });

  // The case this exists for: alerts switched on immediately after a hand
  // search. The snapshot a baseline sweep would go and fetch is already stored,
  // so suppressing costs a full route's calls and an extra interval of waiting
  // to learn nothing.
  it("arms immediately when the route was searched moments ago", () => {
    expect(baselineOnEnable(NOW - 10 * MIN, NOW)).toBe(NOW);
  });

  it("arms right up to the cutoff and suppresses just past it", () => {
    expect(baselineOnEnable(NOW - MAX_SWEEP_MINUTES * MIN, NOW)).toBe(NOW);
    expect(baselineOnEnable(NOW - (MAX_SWEEP_MINUTES * MIN + 1), NOW)).toBeNull();
  });

  it("suppresses for a route that went dark months ago", () => {
    expect(baselineOnEnable(NOW - 90 * 24 * 60 * MIN, NOW)).toBeNull();
  });

  // The cutoff is the slowest cadence the pacer will ever claim, so anything it
  // accepts is no staler than what a routine sweep diffs against.
  it("takes the cutoff from MAX_SWEEP_MINUTES, not a second magic number", () => {
    expect(baselineOnEnable(NOW - 61 * MIN, NOW, 60)).toBeNull();
    expect(baselineOnEnable(NOW - 59 * MIN, NOW, 60)).toBe(NOW);
  });

  it("treats a clock skewed into the future as fresh, never as ancient", () => {
    expect(baselineOnEnable(NOW + 5 * MIN, NOW)).toBe(NOW);
  });
});
