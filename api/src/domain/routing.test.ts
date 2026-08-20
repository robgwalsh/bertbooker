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
  MAX_VIA,
  queryGroupCount,
} from "./routing.js";
import { SEATSAERO_MAX_PAGES } from "../../../shared/src/wire/seatsaero.js";

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

// ---- Hubs -------------------------------------------------------------------
//
// A route on a pair nobody monitors — SFO->KTM is in no program's graph — is
// still reachable through ICN, DEL or HKG. Hubs are the one setting that changes
// what a search COSTS, because `SFO->ICN` and `ICN->KTM` are different markets
// and no single pair of airport lists names both without also naming hub-to-hub
// pairs nobody asked for.

const SFO_KTM = { origins: ["SFO"], destinations: ["KTM"] };
const HUBS = ["ICN", "DEL", "HKG"];

describe("planRoute — query groups", () => {
  it("plans ONE group and nothing else when there are no hubs", () => {
    const plan = planRoute(SEA_NRT);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      role: "direct",
      origins: ["SEA"],
      destinations: ["NRT"],
    });
    // The union is exactly what it always was, which is what makes hubs additive
    // rather than a change to every route.
    expect(plan.pairs).toEqual(routePairs(SEA_NRT));
  });

  it("plans TWO groups with hubs, and asks no hub-to-hub pair", () => {
    const plan = planRoute(SFO_KTM, false, HUBS);
    expect(plan.groups.map((g) => g.role)).toEqual(["outbound", "inbound"]);
    // `ICN->DEL` is the pair a single widened call would have forced us to buy.
    expect(plan.pairs).not.toContainEqual({ origin: "ICN", destination: "DEL" });
    expect(plan.pairs.map((p) => `${p.origin}>${p.destination}`).sort()).toEqual([
      "DEL>KTM",
      "HKG>KTM",
      "ICN>KTM",
      "SFO>DEL",
      "SFO>HKG",
      "SFO>ICN",
      "SFO>KTM",
    ]);
  });

  it("still asks the DIRECT pair every search", () => {
    // The hubs join the outbound query's destination list, so the pair the route
    // is named for rides along at no extra call — which is what lets a hub route
    // notice the day a program starts flying it.
    const plan = planRoute(SFO_KTM, false, HUBS);
    expect(plan.groups[0]!.pairs).toContainEqual({ origin: "SFO", destination: "KTM" });
  });

  it("drops a hub that is already an endpoint", () => {
    // SFO->SFO->KTM is not a connection, and a hub on both sides of the outbound
    // query only buys pairs `pairsOf` then throws away.
    const plan = planRoute(SFO_KTM, false, ["SFO", "KTM", "ICN"]);
    expect(plan.groups[1]!.origins).toEqual(["ICN"]);
  });

  it("caps the hubs rather than refusing the route", () => {
    // They are filled in automatically, so a fourth suggestion must narrow the
    // plan, never make the route unsearchable.
    const plan = planRoute(SFO_KTM, false, ["ICN", "DEL", "HKG", "SIN", "BKK"]);
    expect(plan.groups[1]!.origins).toHaveLength(MAX_VIA);
  });

  it("IGNORES hubs on a round trip, silently", () => {
    // Four groups and a pairing of pairings is a different feature. A route can
    // be flipped to round trip long after its hubs were filled in, and refusing
    // to plan it would break a search over a setting the form does not offer.
    const plan = planRoute(SFO_KTM, true, HUBS);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.role).toBe("direct");
  });

  it("gives each group only the pairs its OWN call covers", () => {
    // The report's `routes` is the coverage claim, and it is built per task from
    // this. A group claiming a pair its call never asked about over-claims, and
    // over-claiming deletes real finds.
    const [outbound, inbound] = planRoute(SFO_KTM, false, HUBS).groups;
    expect(outbound!.pairs.every((p) => p.origin === "SFO")).toBe(true);
    expect(inbound!.pairs.every((p) => p.destination === "KTM")).toBe(true);
  });
});

describe("estimateSearchCalls — hubs", () => {
  it("DOUBLES the calls, which round trip never does", () => {
    const plain = estimateSearchCalls(SFO_KTM, 5);
    const hubbed = estimateSearchCalls(SFO_KTM, 5, false, HUBS);
    expect(plain.groups).toBe(1);
    expect(hubbed.groups).toBe(2);
    expect(hubbed.tasks).toBe(10);
    expect(hubbed.floor).toBe(2 * plain.floor);
    expect(hubbed.ceiling).toBe(10 * SEATSAERO_MAX_PAGES);
  });

  it("does not scale past two, however many hubs there are", () => {
    // Hubs join the lists either side; they cost rows, not calls. That is the
    // whole reason the cap is about truncation rather than quota.
    expect(estimateSearchCalls(SFO_KTM, 5, false, ["ICN"]).floor).toBe(
      estimateSearchCalls(SFO_KTM, 5, false, HUBS).floor,
    );
  });
});

describe("queryGroupCount", () => {
  it("is the multiplier between date chunks and tasks", () => {
    expect(queryGroupCount(SFO_KTM)).toBe(1);
    expect(queryGroupCount(SFO_KTM, false, HUBS)).toBe(2);
    expect(queryGroupCount(SFO_KTM, true, HUBS)).toBe(1);
  });

  it("prices an unplannable route as a plain one rather than throwing", () => {
    // It is called to PRICE a route, and one route the normalizer refuses must
    // not take the Alerts tab's arithmetic down with it.
    expect(queryGroupCount({ origins: [], destinations: [] }, false, HUBS)).toBe(1);
  });
});
