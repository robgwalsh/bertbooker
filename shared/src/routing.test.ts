import { describe, expect, it } from "vitest";
import {
  estimateSearchCalls,
  normalizeAirports,
  normalizeSpec,
  planRoute,
  roundTripSpec,
  routePairs,
  RouteSpecError,
  MAX_ORIGINS,
} from "./routing.js";
import { SEATSAERO_MAX_PAGES } from "./providers/seatsaero.js";

const SEA_NRT = { origins: ["SEA"], destinations: ["NRT"] };

describe("normalizeAirports", () => {
  it("uppercases, trims, dedupes and SORTS", () => {
    // Sorting is not cosmetic. `seatsAeroTaskKey` is built from these lists and
    // `search_tasks` is unique on (run_id, source, task_key), so an unstable
    // order would give the same work two different keys.
    expect(normalizeAirports([" pdx", "SEA", "sea", "PDX "])).toEqual(["PDX", "SEA"]);
  });

  it("drops blanks rather than producing an empty airport code", () => {
    expect(normalizeAirports(["SEA", "", "  "])).toEqual(["SEA"]);
  });
});

describe("normalizeSpec", () => {
  it("THROWS past a cap rather than truncating", () => {
    // Silently dropping the fourth origin would search less than the route says
    // it searches, and the coverage claim would then be about a set of airports
    // nobody chose.
    expect(() => normalizeSpec({ origins: ["A", "B", "C", "D"], destinations: ["NRT"] })).toThrow(
      RouteSpecError,
    );
    expect(MAX_ORIGINS).toBe(3);
  });

  it("needs at least one airport per side", () => {
    expect(() => normalizeSpec({ origins: [], destinations: ["NRT"] })).toThrow(RouteSpecError);
    expect(() => normalizeSpec({ origins: ["SEA"], destinations: [] })).toThrow(RouteSpecError);
  });
});

describe("routePairs", () => {
  it("is one pair for a plain route", () => {
    expect(routePairs(SEA_NRT)).toEqual([{ origin: "SEA", destination: "NRT" }]);
  });

  it("is the whole cross product, covered by ONE call", () => {
    // The economics: seats.aero takes comma-delimited airports on both sides, so
    // four pairs is one query, not four.
    expect(routePairs({ origins: ["SEA", "PDX"], destinations: ["NRT", "HND"] })).toHaveLength(4);
  });

  it("never emits a self-pair", () => {
    // A query for SEA->SEA would claim coverage on a pair no aeroplane flies.
    const pairs = routePairs({ origins: ["SEA", "PDX"], destinations: ["SEA", "NRT"] });
    expect(pairs.every((p) => p.origin !== p.destination)).toBe(true);
    expect(pairs).toHaveLength(3);
  });

  it("dedupes and sorts through normalizeSpec, so a plan is stable", () => {
    expect(routePairs({ origins: ["pdx", "SEA", "sea"], destinations: ["NRT"] })).toEqual([
      { origin: "PDX", destination: "NRT" },
      { origin: "SEA", destination: "NRT" },
    ]);
  });
});

describe("estimateSearchCalls", () => {
  it("quotes a range, because the true cost depends on how many rows exist", () => {
    const plain = estimateSearchCalls(SEA_NRT, 5);
    expect(plain).toMatchObject({ pairs: 1, floor: 5 });
    expect(plain.ceiling).toBe(5 * SEATSAERO_MAX_PAGES);
  });

  it("does NOT scale with pairs — which is the whole point", () => {
    // Four pairs cost exactly what one pair costs, because one call covers them
    // all. Only the number of date chunks adds calls.
    const wide = estimateSearchCalls({ origins: ["SEA", "PDX"], destinations: ["NRT", "HND"] }, 5);
    expect(wide.pairs).toBe(4);
    expect(wide.floor).toBe(5);
  });
});

describe("roundTripSpec / planRoute", () => {
  it("puts every airport on BOTH sides, so one call covers both directions", () => {
    expect(roundTripSpec(SEA_NRT)).toEqual({
      origins: ["NRT", "SEA"],
      destinations: ["NRT", "SEA"],
    });
  });

  it("plans exactly the outbound and the return, self-pairs dropped", () => {
    expect(planRoute(SEA_NRT, true).pairs).toEqual([
      { origin: "NRT", destination: "SEA" },
      { origin: "SEA", destination: "NRT" },
    ]);
  });

  it("leaves a one-way route completely alone", () => {
    expect(planRoute(SEA_NRT, false).pairs).toEqual([{ origin: "SEA", destination: "NRT" }]);
    expect(planRoute(SEA_NRT).pairs).toEqual([{ origin: "SEA", destination: "NRT" }]);
  });

  // The union legitimately exceeds MAX_ORIGINS; the cap governs what the USER
  // may type, not what the expansion produces. Re-checking it here would reject
  // a route the form was right to accept.
  it("allows the union to exceed the per-side cap", () => {
    const wide = { origins: ["SEA", "PDX", "BFI"], destinations: ["NRT", "HND", "KIX"] };
    expect(() => routePairs(wide)).not.toThrow();
    const plan = planRoute(wide, true);
    expect(plan.origins).toHaveLength(6);
    expect(plan.destinations).toHaveLength(6);
    // 6x6 minus the six self-pairs.
    expect(plan.pairs).toHaveLength(30);
  });

  it("still refuses a spec the user should never have saved", () => {
    expect(() => planRoute({ origins: [], destinations: ["NRT"] }, true)).toThrow(RouteSpecError);
    expect(() =>
      planRoute({ origins: ["SEA", "PDX", "BFI", "LAX"], destinations: ["NRT"] }, true),
    ).toThrow(RouteSpecError);
  });

  it("claims coverage for the return direction, which is what lets it be pruned", () => {
    const pairs = planRoute(SEA_NRT, true).pairs;
    expect(pairs).toContainEqual({ origin: "NRT", destination: "SEA" });
  });

  it("raises the pair count in the estimate but never the call count", () => {
    const one = estimateSearchCalls(SEA_NRT, 5, false);
    const rt = estimateSearchCalls(SEA_NRT, 5, true);
    expect(one.pairs).toBe(1);
    expect(rt.pairs).toBe(2);
    // The headline: a round trip is free. Same chunks, same calls, same quota.
    expect(rt.floor).toBe(one.floor);
    expect(rt.ceiling).toBe(one.ceiling);
  });
});
