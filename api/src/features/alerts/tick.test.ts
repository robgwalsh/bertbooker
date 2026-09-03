import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runAlertTick`'s loop — the one impure part of the scheduler, and the part
 * that was wrong.
 *
 * The rest of `alerts/` is pure and tested in `alerts.test.ts` without a D1.
 * This file exists because the bug was not in any of those functions:
 * `sweepPacing` correctly returned `every 15m`, `dueRoutes` correctly returned
 * all four routes, and the tick then swept `due[0]` and threw the other three
 * away. Nothing pure could have caught that, so the loop is stubbed at its two
 * real boundaries — D1 and `features/search/run.ts` — and asserted directly.
 */

const passResult = (calls: number, paused = false) => ({
  runId: "run-1",
  paused,
  nextIndex: 0,
  total: 1,
  totals: { ok: 1, failed: 0, offers: 0, written: 0, pruned: 0, calls },
  changes: [],
  status: "ok" as const,
});

const runSearchPass = vi.fn();

vi.mock("../search/run.js", () => ({
  planSearchPass: vi.fn(async () => ({ ok: true, plan: { tasks: [{}] } })),
  openSearchRun: vi.fn(async () => ({ ok: true, runId: "run-1", startedAt: 0 })),
  runSearchPass: (...args: unknown[]) => runSearchPass(...args),
}));

const { runAlertTick } = await import("./tick.js");

/** Dates inside seats.aero's horizon — `planSeatsAeroChunks` returns nothing
 *  for a window past it, and a zero-chunk route is never due. */
const soon = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** The four routes this actually happened on: narrow windows, no hubs, one
 *  chunk and therefore one call apiece. `observed_calls: 1` is what the last
 *  sweep of each measured, so `routeSweepCost` prices the cycle at 4. */
const routeRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  origin: "PIT",
  destination: "SLC",
  origins: null,
  destinations: null,
  date_start: soon(60),
  date_end: soon(62),
  cabins: null,
  min_seats: 1,
  point_limit: null,
  round_trip: 0,
  via: null,
  alert_email: null,
  alert_on: null,
  alert_min_drop_pct: 5,
  // 25 hours ago — past MAX_SWEEP_MINUTES, so these are due at ANY interval
  // `sweepPacing` can return and a test never has to restate the cadence its
  // own route costs imply.
  alert_last_attempt_at: Date.now() - 25 * 60 * 60_000,
  alert_last_digest_at: Date.now() - 25 * 60 * 60_000,
  alert_consecutive_failures: 0,
  last_checked_at: Date.now() - 25 * 60 * 60_000,
  observed_calls: 1,
  ...over,
});

/** A D1 stub that dispatches on the SQL text. Deliberately dumb: the tick's
 *  writes are fire-and-forget from its own point of view, so only the reads
 *  need real answers. */
function stubDb(
  rows: ReturnType<typeof routeRow>[],
  quota: { spent: number; allowancePct?: number },
) {
  const answer = (sql: string): { results: Record<string, unknown>[] } => {
    if (sql.includes("FROM tracked_routes tr") && sql.includes("alerts_enabled = 1"))
      return { results: rows as unknown as Record<string, unknown>[] };
    if (sql.includes("FROM source_quota")) return { results: [] };
    if (sql.includes("SUM(calls)")) return { results: [{ spent: quota.spent }] };
    // No row is the default allowance, 80% of the assumed 1000 — an 800 budget.
    if (sql.includes("FROM settings"))
      return {
        results: quota.allowancePct == null ? [] : [{ value: String(quota.allowancePct) }],
      };
    // `cycleComplete` — the flush is not what this file is about, so it is
    // always told the cycle is over and `alert_outbox` is always empty.
    if (sql.includes("AS due")) return { results: [{ due: 0, running: 0 }] };
    return { results: [] };
  };
  // One object per statement, carrying its own SQL, so `db.batch` (which
  // `readBudgetState` uses) can answer each member in order.
  const stmt = (sql: string) => {
    const self = {
      __sql: sql,
      bind: () => self,
      all: async () => answer(sql),
      first: async () => answer(sql).results[0] ?? null,
      run: async () => ({}),
    };
    return self;
  };
  return {
    prepare: stmt,
    batch: async (stmts: { __sql: string }[]) => stmts.map((s) => answer(s.__sql)),
  } as unknown as D1Database;
}

const env = (rows: ReturnType<typeof routeRow>[], spent = 0, allowancePct?: number) =>
  ({
    DB: stubDb(rows, { spent, allowancePct }),
    APP_USER_EMAIL: "a@example.com",
    SEATS_AERO_API_KEY: "k",
  }) as never;

describe("runAlertTick — the tick sweeps to its CALL cap, not to one route", () => {
  beforeEach(() => {
    runSearchPass.mockReset();
    runSearchPass.mockResolvedValue(passResult(1));
  });

  it("sweeps EVERY due route when they fit in the tick's call budget", async () => {
    const result = await runAlertTick(env([4, 5, 7, 8].map((id) => routeRow(id))));
    expect(result.sweptRouteIds).toEqual([4, 5, 7, 8]);
  });

  it("stops at ALERT_MAX_CALLS_PER_TICK, so the ceiling is unchanged", async () => {
    // The bound that replaced "one route" has to actually bind. Five calls a
    // route, a cap of 25 — five routes and no more, however many are due.
    runSearchPass.mockResolvedValue(passResult(5));
    const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => routeRow(id, { observed_calls: 5 }));
    const result = await runAlertTick(env(rows));
    expect(result.sweptRouteIds).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives a whole tick to one route that wants it — the pre-existing shape", async () => {
    // A wide route pausing at the cap is exactly what happened before this
    // change, and must still happen. It consumes the budget and nothing follows.
    runSearchPass.mockResolvedValue(passResult(25, true));
    const rows = [1, 2, 3].map((id) => routeRow(id, { observed_calls: 25 }));
    const result = await runAlertTick(env(rows));
    expect(result.sweptRouteIds).toEqual([1]);
  });

  it("passes each route only the calls the tick has LEFT", async () => {
    // Not `maxCallsPerTick` each — that would let a tick spend a multiple of its
    // own cap, which is the CPU-limit kill docs/ALERTS.md §2 warns about.
    runSearchPass.mockResolvedValue(passResult(10));
    await runAlertTick(env([1, 2, 3].map((id) => routeRow(id, { observed_calls: 10 }))));
    const budgets = runSearchPass.mock.calls.map((c) => (c[3] as { maxCalls: number }).maxCalls);
    expect(budgets).toEqual([25, 15, 5]);
  });

  it("still sweeps exactly one route when forced, whatever else is due", async () => {
    // `POST /api/alerts/run` takes a route id. "Sweep this one and tell me what
    // happened" is the question, and a loop would answer a different one.
    const result = await runAlertTick(env([4, 5, 7, 8].map((id) => routeRow(id))), { force: 7 });
    expect(result.sweptRouteIds).toEqual([7]);
  });

  it("skips a route the guard refuses for RESERVE but keeps going", async () => {
    // `reserve` is measured against this route's estimated cost, so a cheaper
    // route later can legitimately pass a test this one failed. Breaking the
    // loop here would let one expensive route silence every cheap one behind it.
    // 750 already spent today against the default 800 daily budget: a 100-call
    // route busts it, a 1-call route does not. (The stub does not advance
    // `spent` as the tick runs — the loop re-reads, which is asserted by the
    // fact that it asks at all, not by this number moving.)
    const rows = [
      routeRow(1, { observed_calls: 100 }),
      routeRow(2, { observed_calls: 1 }),
      routeRow(3, { observed_calls: 1 }),
    ];
    const result = await runAlertTick(env(rows, 750));
    expect(result.skipped.map((s) => s.routeId)).toEqual([1]);
    expect(result.sweptRouteIds).toEqual([2, 3]);
  });

  it("reads the allowance from the settings table, not from the environment", async () => {
    // At 10% the budget is 100 of the assumed 1000, so a 100-call route on a
    // day with 50 spent is refused — the same route the default lets through.
    const rows = [routeRow(1, { observed_calls: 100 })];
    const result = await runAlertTick(env(rows, 50, 10));
    expect(result.sweptRouteIds).toEqual([]);
    expect(result.skipped).toEqual([{ routeId: 1, reason: "reserve" }]);
    expect(runSearchPass).not.toHaveBeenCalled();
  });

  it("breaks the loop when the guard says EXHAUSTED — no route can pass that", async () => {
    // `exhausted` is `remaining <= 0`, which is cost-independent. Continuing
    // would ask the same question of every remaining route and get the same no,
    // at one D1 batch apiece.
    const rows = [1, 2, 3, 4].map((id) => routeRow(id));
    const result = await runAlertTick(env(rows, 1000));
    expect(result.sweptRouteIds).toEqual([]);
    expect(result.skipped).toEqual([{ routeId: 1, reason: "exhausted" }]);
  });
});
