import { describe, expect, it } from "vitest";
import type { ChangeSummary, ChangeType } from "../domain/diff.js";
import {
  MAX_SWEEP_MINUTES,
  MIN_SWEEP_MINUTES,
  baselineOnEnable,
  dueRoutes,
  routeDueAt,
  routeSweepCost,
  sweepPacing,
} from "./pace.js";
import { DEFAULT_ALERT_TYPES, dropPercent, parseAlertTypes, selectAlertable } from "./select.js";

const MIN = 60_000;

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
    // One route measured at 10 calls, 600 budget => 60 cycles/day => every 24m.
    const p = sweepPacing({
      routes: [{ routeId: 1, chunks: 5, observedCalls: 10 }],
      dailyBudget: 600,
    });
    expect(p.affordable).toBe(true);
    if (p.affordable) {
      expect(p.cyclesPerDay).toBe(60);
      expect(p.intervalMinutes).toBe(24);
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

describe("parseAlertTypes", () => {
  it("treats NULL as the default set", () => {
    expect(parseAlertTypes(null)).toEqual(DEFAULT_ALERT_TYPES);
  });

  it("leaves `gone` out of the default set", () => {
    expect(DEFAULT_ALERT_TYPES).not.toContain("gone");
  });

  it("keeps a stored selection", () => {
    expect(parseAlertTypes('["gone","price_drop"]')).toEqual(["gone", "price_drop"]);
  });

  it("falls back rather than going silent on a corrupted value", () => {
    // An empty set is refused at the API, so reading one back means damage —
    // and "alerts on, nothing fires" is the failure mode that looks like success.
    expect(parseAlertTypes("[]")).toEqual(DEFAULT_ALERT_TYPES);
    expect(parseAlertTypes('["nonsense"]')).toEqual(DEFAULT_ALERT_TYPES);
    expect(parseAlertTypes("not json")).toEqual(DEFAULT_ALERT_TYPES);
  });
});

const change = (over: Partial<ChangeSummary> & { type: ChangeType; key: string }): ChangeSummary => ({
  flightDate: "2026-11-14",
  program: "alaska",
  cabin: "business",
  origin: "SEA",
  destination: "NRT",
  ...over,
});

describe("dropPercent", () => {
  it("measures the fall against what it was", () => {
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 80, previousMilesCost: 100 }))).toBe(20);
  });

  it("is zero when there is nothing to compare, or the price rose", () => {
    expect(dropPercent(change({ type: "new", key: "k", milesCost: 80 }))).toBe(0);
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 120, previousMilesCost: 100 }))).toBe(0);
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 80, previousMilesCost: 0 }))).toBe(0);
  });
});

describe("selectAlertable", () => {
  const rule = { types: ["new", "price_drop"] as ChangeType[], minDropPct: 5 };
  const filters = { cabins: null, minSeats: 2 };

  it("keeps only the types the route asked for", () => {
    const changes = [
      change({ type: "new", key: "a" }),
      change({ type: "more_seats", key: "b" }),
    ];
    const out = selectAlertable(changes, new Set(["a", "b"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("drops a change the route's own filters would hide", () => {
    // The key is absent from the finds query, so the route's pane would not show
    // it — an email about it would contradict the app.
    const changes = [change({ type: "new", key: "a" }), change({ type: "new", key: "b" })];
    const out = selectAlertable(changes, new Set(["a"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("applies the minimum drop percentage", () => {
    const small = change({ type: "price_drop", key: "a", milesCost: 98, previousMilesCost: 100 });
    const big = change({ type: "price_drop", key: "b", milesCost: 80, previousMilesCost: 100 });
    const out = selectAlertable([small, big], new Set(["a", "b"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["b"]);
  });

  it("lets `gone` bypass the find intersection — there is no row left to match", () => {
    // Intersecting would silently drop every disappearance, which is the entire
    // point of the type.
    const gone = change({ type: "gone", key: "a", previousSeats: 4, previousMilesCost: 100 });
    const out = selectAlertable([gone], new Set(), { types: ["gone"], minDropPct: 5 }, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("still filters `gone` on what the summary carries", () => {
    const wrongCabin = change({ type: "gone", key: "a", cabin: "economy", previousSeats: 4 });
    const tooFewSeats = change({ type: "gone", key: "b", previousSeats: 1 });
    const out = selectAlertable(
      [wrongCabin, tooFewSeats],
      new Set(),
      { types: ["gone"], minDropPct: 5 },
      { cabins: ["business"], minSeats: 2 },
    );
    expect(out).toEqual([]);
  });

  it("drops a `gone` for an award the route's point limit hid anyway", () => {
    // It was over the ceiling while it existed, so the pane never showed it and
    // its disappearance is not this route's news.
    const tooDear = change({ type: "gone", key: "a", previousSeats: 4, previousMilesCost: 90_000 });
    const affordable = change({ type: "gone", key: "b", previousSeats: 4, previousMilesCost: 50_000 });
    // An unpriced summary passes: refusing what we cannot price would silently
    // drop real disappearances, which is what `gone` exists to catch.
    const unpriced = change({ type: "gone", key: "c", previousSeats: 4 });
    const out = selectAlertable(
      [tooDear, affordable, unpriced],
      new Set(),
      { types: ["gone"], minDropPct: 5 },
      { cabins: null, minSeats: 2, pointLimit: 60_000 },
    );
    expect(out.map((c) => c.key)).toEqual(["b", "c"]);
  });

  it("de-duplicates a key seen twice across passes", () => {
    const a = change({ type: "new", key: "a" });
    const out = selectAlertable([a, a], new Set(["a"]), rule, filters);
    expect(out).toHaveLength(1);
  });

  it("pins the first-match-wins shadow: a drop WITH more seats classifies as more_seats", () => {
    // diffAvailability checks seats before price (diff.ts), so this event never
    // reaches a route that enabled price_drop but not more_seats. Changing the
    // classifier would change changes_json for the alert sweep too, so the behaviour is
    // documented in the UI rather than fixed — and pinned here so a future
    // change breaks a test instead of an inbox.
    const shadowed = change({
      type: "more_seats",
      key: "a",
      milesCost: 80,
      previousMilesCost: 100,
      seatsAvailable: 4,
      previousSeats: 2,
    });
    const out = selectAlertable([shadowed], new Set(["a"]), rule, filters);
    expect(out).toEqual([]);
  });
});
