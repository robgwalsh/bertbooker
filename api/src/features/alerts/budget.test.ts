import { describe, expect, it } from "vitest";
import {
  ASSUMED_DAILY_LIMIT,
  alertAllowance,
  clampAllowancePct,
  decideSweep,
  utcDay,
  utcDayStart,
} from "./scheduler-budget.js";

// Follows the gate.test.ts precedent: this workspace has no D1 or Worker test
// harness, so only the pure exported half is tested — which is deliberately
// where all of the reasoning lives.

const base = { selfSpentToday: 0, estimatedCost: 25, reserve: 300, dailyBudget: 600 };

describe("decideSweep — with an observation", () => {
  const observed = (remaining: number) => ({
    observation: { remaining, limitCalls: 1000, observedAt: 1 },
  });

  it("goes when there is room above the reserve", () => {
    const d = decideSweep({ ...base, ...observed(900) });
    expect(d.go).toBe(true);
    expect(d.basis).toBe("observed");
    expect(d.projectedRemaining).toBe(875);
  });

  it("refuses when the sweep would eat into the reserve", () => {
    // The reserve exists so a human pressing Search at 9pm gets an answer
    // rather than a 429 a robot caused.
    const d = decideSweep({ ...base, ...observed(310) });
    expect(d.go).toBe(false);
    if (!d.go) expect(d.reason).toBe("reserve");
  });

  it("refuses when the allowance is gone", () => {
    const d = decideSweep({ ...base, ...observed(0) });
    expect(d.go).toBe(false);
    if (!d.go) expect(d.reason).toBe("exhausted");
  });

  it("compares against what is left AFTER the sweep, not before", () => {
    // 320 remaining is above the 300 reserve, but spending 25 lands at 295.
    const d = decideSweep({ ...base, ...observed(320) });
    expect(d.go).toBe(false);
  });
});

describe("decideSweep — with no observation for today", () => {
  it("self-accounts rather than refusing", () => {
    // Refusing would mean alerts never fire on any day nobody manually searched
    // — nearly all of them — and the feature would die silently.
    const d = decideSweep({ ...base, selfSpentToday: 100 });
    expect(d.go).toBe(true);
    expect(d.basis).toBe("self_accounted");
    expect(d.projectedRemaining).toBe(ASSUMED_DAILY_LIMIT - 100 - 25);
  });

  it("self-accounts rather than assuming a full allowance", () => {
    // Assuming 1000 is optimistic in the one direction that overspends.
    const d = decideSweep({ ...base, selfSpentToday: 690, reserve: 300 });
    expect(d.go).toBe(false);
    if (!d.go) expect(d.reason).toBe("reserve");
  });

  it("still honours the scheduler's own daily allowance", () => {
    // Plenty of quota left against the reserve, but automation has spent its
    // share — the reserve is not the only ceiling.
    const d = decideSweep({ ...base, selfSpentToday: 590, reserve: 0, dailyBudget: 600 });
    expect(d.go).toBe(false);
  });
});

describe("utcDay / utcDayStart", () => {
  it("keys on the UTC day the allowance resets on", () => {
    // 23:30 UTC and 00:30 UTC the next day are different allowances.
    expect(utcDay(Date.parse("2026-08-13T23:30:00Z"))).toBe("2026-08-13");
    expect(utcDay(Date.parse("2026-08-14T00:30:00Z"))).toBe("2026-08-14");
  });

  it("starts the self-accounting window at midnight UTC", () => {
    expect(utcDayStart(Date.parse("2026-08-13T23:30:00Z"))).toBe(
      Date.parse("2026-08-13T00:00:00Z"),
    );
  });
});

describe("alertAllowance", () => {
  it("splits the day's limit at the percentage: the rest is the reserve", () => {
    expect(alertAllowance(80, 1000)).toEqual({ dailyBudget: 800, reserve: 200 });
    expect(alertAllowance(80, 2000)).toEqual({ dailyBudget: 1600, reserve: 400 });
  });

  it("covers both ends of the slider", () => {
    expect(alertAllowance(0, 1000)).toEqual({ dailyBudget: 0, reserve: 1000 });
    expect(alertAllowance(100, 1000)).toEqual({ dailyBudget: 1000, reserve: 0 });
  });

  it("rounds the budget down so the two halves still sum to the limit", () => {
    expect(alertAllowance(33, 1000)).toEqual({ dailyBudget: 330, reserve: 670 });
    expect(alertAllowance(33, 999)).toEqual({ dailyBudget: 329, reserve: 670 });
  });
});

describe("clampAllowancePct", () => {
  it("keeps a whole number in range", () => {
    expect(clampAllowancePct(80, 80)).toBe(80);
    expect(clampAllowancePct(0, 80)).toBe(0);
    expect(clampAllowancePct(100, 80)).toBe(100);
  });

  it("rounds and clamps", () => {
    expect(clampAllowancePct(79.6, 80)).toBe(80);
    expect(clampAllowancePct(150, 80)).toBe(100);
    expect(clampAllowancePct(-5, 80)).toBe(0);
  });

  it("falls back on anything that is not a number", () => {
    expect(clampAllowancePct(Number.NaN, 80)).toBe(80);
    expect(clampAllowancePct("80", 80)).toBe(80);
    expect(clampAllowancePct(undefined, 80)).toBe(80);
  });
});
