import { describe, expect, it } from "vitest";

import { type MatchableFind, type MatchableRoute, matchesRoute } from "./routeMatch.js";

/**
 * One witness per branch of the SQL `ROUTE_FINDS_MATCH` this replaces, in the
 * same spirit as `api/src/db/finds.test.ts` pins one witness per branch of the
 * scope superset. The two files are a pair: that one proves the D1 read fetches
 * a find, this one proves the predicate then accepts it.
 */

const route = (over: Partial<MatchableRoute> = {}): MatchableRoute => ({
  origin: "SEA",
  destination: "NRT",
  origins: null,
  destinations: null,
  via: null,
  date_start: "2026-10-08",
  date_end: "2026-10-10",
  round_trip: 0,
  cabins: null,
  currencies: null,
  direct_only: 0,
  point_limit: null,
  min_seats: 1,
  ...over,
});

const find = (over: Partial<MatchableFind> = {}): MatchableFind => ({
  origin: "SEA",
  destination: "NRT",
  flight_date: "2026-10-09",
  cabin: "business",
  transfer_currencies: '["chase_ur"]',
  is_direct: 1,
  miles_cost: 60_000,
  seats_available: 2,
  ...over,
});

describe("the three membership branches", () => {
  it("accepts the forward pair inside the window", () => {
    expect(matchesRoute(find(), route())).toBe(true);
  });

  it("reads origins/destinations as SETS, not equality", () => {
    const r = route({ origins: '["SEA","PDX"]', destinations: '["NRT","HND"]' });
    expect(matchesRoute(find({ origin: "PDX", destination: "HND" }), r)).toBe(true);
    // A PDX find must not appear under a SEA-only route.
    expect(matchesRoute(find({ origin: "PDX" }), route())).toBe(false);
  });

  it("accepts the REVERSED pair only when round_trip is on", () => {
    const back = find({ origin: "NRT", destination: "SEA" });
    expect(matchesRoute(back, route({ round_trip: 1 }))).toBe(true);
    // Without it those return legs are stored, covered, and invisible — the
    // exact "looks like no award space" failure the branch exists to prevent.
    expect(matchesRoute(back, route())).toBe(false);
  });

  it("accepts a first hub leg: an origin to a hub, ordinary window", () => {
    const r = route({ destination: "KTM", via: '["ICN","TPE"]' });
    expect(matchesRoute(find({ destination: "ICN" }), r)).toBe(true);
    expect(matchesRoute(find({ destination: "ICN" }), route({ destination: "KTM" }))).toBe(false);
  });

  it("accepts a second hub leg one day PAST the window close", () => {
    const r = route({ destination: "KTM", via: '["ICN"]' });
    const leg = (d: string) => find({ origin: "ICN", destination: "KTM", flight_date: d });
    // An overnight in the hub on the last gathered date is a real journey, and
    // the shared window test would clip exactly it.
    expect(matchesRoute(leg("2026-10-11"), r)).toBe(true);
    expect(matchesRoute(leg("2026-10-12"), r)).toBe(false);
    // The widening is the SECOND leg's alone.
    expect(matchesRoute(find({ flight_date: "2026-10-11" }), route())).toBe(false);
  });

  it("does not gate the hub branches on round_trip", () => {
    // planRoute ignores `via` for round trips, but this reads what was
    // GATHERED: a route searched with hubs before round-trip was turned on
    // still has those legs stored.
    const r = route({ destination: "KTM", via: '["ICN"]', round_trip: 1 });
    expect(matchesRoute(find({ destination: "ICN" }), r)).toBe(true);
  });

  it("rejects a find outside the window on every branch", () => {
    expect(matchesRoute(find({ flight_date: "2026-10-07" }), route())).toBe(false);
  });
});

describe("the filter clauses", () => {
  it("honours min_seats", () => {
    expect(matchesRoute(find({ seats_available: 1 }), route({ min_seats: 2 }))).toBe(false);
    expect(matchesRoute(find({ seats_available: 2 }), route({ min_seats: 2 }))).toBe(true);
  });

  it("honours direct_only — the one clause with no prior TS twin", () => {
    expect(matchesRoute(find({ is_direct: 0 }), route({ direct_only: 1 }))).toBe(false);
    expect(matchesRoute(find({ is_direct: 0 }), route({ direct_only: 0 }))).toBe(true);
  });

  it("honours point_limit against miles_cost", () => {
    expect(matchesRoute(find({ miles_cost: 100_001 }), route({ point_limit: 100_000 }))).toBe(
      false,
    );
    expect(matchesRoute(find({ miles_cost: 100_000 }), route({ point_limit: 100_000 }))).toBe(true);
  });

  it("honours the cabin filter, null meaning any", () => {
    expect(matchesRoute(find({ cabin: "economy" }), route({ cabins: '["business"]' }))).toBe(false);
    expect(matchesRoute(find({ cabin: "economy" }), route({ cabins: null }))).toBe(true);
  });

  it("intersects currencies rather than comparing them", () => {
    const r = route({ currencies: '["citi_ty","amex_mr"]' });
    expect(matchesRoute(find({ transfer_currencies: '["chase_ur","amex_mr"]' }), r)).toBe(true);
    expect(matchesRoute(find({ transfer_currencies: '["chase_ur"]' }), r)).toBe(false);
  });
});

describe("where this deliberately differs from the SQL's callers", () => {
  it("reads an EMPTY filter array as matching nothing", () => {
    // EXISTS over zero json_each rows was false, so `[]` excluded everything.
    // `legFilter` in app/src/lib/multiLeg.ts read it as "no filter" — the
    // opposite. Unreachable through the API, which normalises `[]` to NULL.
    expect(matchesRoute(find(), route({ cabins: "[]" }))).toBe(false);
    expect(matchesRoute(find(), route({ currencies: "[]" }))).toBe(false);
  });

  it("excludes a find with NULL transfer_currencies from a currency-filtered route", () => {
    // json_each(NULL) yields no rows to intersect.
    const r = route({ currencies: '["citi_ty"]' });
    expect(matchesRoute(find({ transfer_currencies: null }), r)).toBe(false);
    // ...but an unfiltered route still shows it.
    expect(matchesRoute(find({ transfer_currencies: null }), route())).toBe(true);
  });

  it("reads a MALFORMED filter column as no filter rather than failing", () => {
    // The SQL raised a SQLite error and failed the whole request. Blanking the
    // Routes page over one bad column is worse than showing an unfiltered row.
    expect(matchesRoute(find({ cabin: "economy" }), route({ cabins: "not json" }))).toBe(true);
  });

  it("falls back to the scalar when the airport array is absent or malformed", () => {
    expect(matchesRoute(find(), route({ origins: "not json" }))).toBe(true);
    expect(matchesRoute(find({ origin: "PDX" }), route({ origins: "not json" }))).toBe(false);
  });
});
