import { describe, expect, it } from "vitest";
import { REACH_PATHS_PER_PAIR, assessGraphReach, type ReachRouteInput } from "./reach.js";
import type { GraphPair } from "../../db/routeGraph.js";
import type { GraphPath } from "../../../../shared/src/wire/index.js";

// `assessGraphReach` answers "is this pair in anyone's graph", NOT "did anyone
// search it" — that second question is coverage, and the two must not merge.
// These tests are about the first one only.

const route = (over: Partial<ReachRouteInput> = {}): ReachRouteInput => ({
  id: 1,
  origin: "SFO",
  destination: "NRT",
  origins: null,
  destinations: null,
  roundTrip: false,
  programs: null,
  ...over,
});

const pair = (origin: string, destination: string, source: string): GraphPair => ({
  origin,
  destination,
  source,
});

/** alaska -> a stored program; smiles -> a source we knowingly don't map. */
const programOf = (source: string): string | null =>
  ({ alaska: "alaska", american: "aadvantage" })[source] ?? null;

const assess = (
  routes: ReachRouteInput[],
  graph: GraphPair[],
  fetched: string[],
  totalSources = 26,
) => assessGraphReach({ routes, graph, fetched, programOf, totalSources });

describe("assessGraphReach", () => {
  it("says ok when a fetched source flies the pair", () => {
    const out = assess([route()], [pair("SFO", "NRT", "alaska")], ["alaska"]);
    expect(out.routes[0]!.verdict).toBe("ok");
    expect(out.routes[0]!.pairs[0]!.programs).toEqual(["alaska"]);
  });

  it("says gap when sources are fetched and none flies it", () => {
    const out = assess([route()], [], ["alaska"]);
    expect(out.routes[0]!.verdict).toBe("gap");
  });

  it("says unknown — never gap — when nothing has been fetched", () => {
    // The distinction the fetch-record table exists for, carried all the way
    // through to the verdict: absence of data is not data.
    const out = assess([route()], [], []);
    expect(out.routes[0]!.verdict).toBe("unknown");
    expect(out.fetchedSources).toBe(0);
  });

  it("ignores rows from a source that is not in the fetched set", () => {
    // A `failed` re-fetch leaves the previous graph in place. Those rows are
    // not authoritative, so they cannot turn a gap into an ok.
    const out = assess([route()], [pair("SFO", "NRT", "alaska")], ["american"]);
    expect(out.routes[0]!.verdict).toBe("gap");
  });

  it("reports an unmapped source as reach we cannot book", () => {
    // Smiles really flies it; this app stores no program for Smiles. That is
    // worth seeing rather than hiding, so it counts as `ok` and is named.
    const out = assess([route()], [pair("SFO", "NRT", "smiles")], ["smiles"]);
    expect(out.routes[0]!.verdict).toBe("ok");
    expect(out.routes[0]!.pairs[0]!.programs).toEqual([]);
    expect(out.routes[0]!.pairs[0]!.unmappedSources).toEqual(["smiles"]);
  });

  it("honours the route's own program filter", () => {
    // Without this a route could read as reachable through a program it
    // deliberately excludes.
    const graph = [pair("SFO", "NRT", "alaska")];
    expect(assess([route({ programs: ["aadvantage"] })], graph, ["alaska"]).routes[0]!.verdict).toBe(
      "gap",
    );
    expect(assess([route({ programs: ["alaska"] })], graph, ["alaska"]).routes[0]!.verdict).toBe(
      "ok",
    );
  });

  it("takes a multi-airport route's WORST pair", () => {
    // SEA/PDX -> NRT/HND is four pairs. Three covered and one in nobody's graph
    // is a route with a named hole, not a route that is mostly fine.
    const multi = route({ origins: ["SEA", "PDX"], destinations: ["NRT", "HND"] });
    const graph = [
      pair("SEA", "NRT", "alaska"),
      pair("SEA", "HND", "alaska"),
      pair("PDX", "NRT", "alaska"),
      // PDX->HND is absent.
    ];
    const out = assess([multi], graph, ["alaska"]);
    expect(out.routes[0]!.pairs).toHaveLength(4);
    expect(out.routes[0]!.verdict).toBe("gap");
    expect(out.routes[0]!.pairs.filter((p) => p.verdict === "gap")).toEqual([
      expect.objectContaining({ origin: "PDX", destination: "HND" }),
    ]);
  });

  it("says ok only when EVERY pair is flown", () => {
    const multi = route({ origins: ["SEA", "PDX"], destinations: ["NRT"] });
    const out = assess(
      [multi],
      [pair("SEA", "NRT", "alaska"), pair("PDX", "NRT", "alaska")],
      ["alaska"],
    );
    expect(out.routes[0]!.verdict).toBe("ok");
  });

  it("expands a round trip into both directions", () => {
    // The same expansion the search plans with, so the panel cannot report on a
    // pair the search never asks about.
    const out = assess([route({ roundTrip: true })], [pair("SFO", "NRT", "alaska")], ["alaska"]);
    const pairs = out.routes[0]!.pairs.map((p) => `${p.origin}>${p.destination}`);
    expect(pairs).toContain("SFO>NRT");
    expect(pairs).toContain("NRT>SFO");
    // Only the outbound is in the graph, so the route as a whole has a hole.
    expect(out.routes[0]!.verdict).toBe("gap");
  });

  it("carries the catalogue size so a gap can be qualified honestly", () => {
    const out = assess([route()], [], ["alaska"], 26);
    expect(out.fetchedSources).toBe(1);
    expect(out.totalSources).toBe(26);
  });

  it("survives a route whose spec the normalizer refuses", () => {
    // This surface reports on routes; it does not police them, and one bad row
    // must not take the whole panel down.
    const bad = route({ origins: [], destinations: [], origin: "", destination: "" });
    const out = assess([bad], [], ["alaska"]);
    expect(out.routes[0]!.pairs).toEqual([]);
    expect(out.routes[0]!.verdict).toBe("unknown");
  });
});

// ---- Reachable with a stop --------------------------------------------------
//
// `indirect` is the verdict that stops a long-haul with no nonstop market from
// reading as impossible. It is NOT `ok`: a search of the route as written still
// returns nothing, because seats.aero holds availability per monitored market
// and this pair is not one. The action is to track the legs.

const path = (via: string[], programs: string[], over: Partial<GraphPath> = {}): GraphPath => ({
  legs: [],
  via,
  totalMi: 8000,
  detour: 1.05,
  programs,
  unmappedSources: [],
  mixed: programs.length === 0,
  ...over,
});

const assessWithPaths = (
  routes: ReachRouteInput[],
  graph: GraphPair[],
  fetched: string[],
  paths: Record<string, GraphPath[]>,
  extra: { deepSkipped?: Set<string>; deepCheckedPairs?: number; deepPairLimit?: number } = {},
) =>
  assessGraphReach({
    routes,
    graph,
    fetched,
    programOf,
    totalSources: 26,
    paths: new Map(Object.entries(paths)),
    ...extra,
  });

describe("assessGraphReach — connections", () => {
  it("says indirect, not gap, when a path reaches the pair", () => {
    const out = assessWithPaths([route()], [], ["alaska"], {
      "SFO>NRT": [path(["ICN"], ["alaska"])],
    });
    expect(out.routes[0]!.verdict).toBe("indirect");
    expect(out.routes[0]!.pairs[0]!.paths[0]!.via).toEqual(["ICN"]);
  });

  it("stays gap when nothing was found either way", () => {
    const out = assessWithPaths([route()], [], ["alaska"], {});
    expect(out.routes[0]!.verdict).toBe("gap");
    expect(out.routes[0]!.pairs[0]!.paths).toEqual([]);
  });

  it("prefers a DIRECT edge over a path, and carries no paths on an ok pair", () => {
    // A pair somebody actually monitors is answered by the search itself. Paths
    // there would be an answer to a question nobody asked.
    const out = assessWithPaths([route()], [pair("SFO", "NRT", "alaska")], ["alaska"], {
      "SFO>NRT": [path(["ICN"], ["alaska"])],
    });
    expect(out.routes[0]!.verdict).toBe("ok");
    expect(out.routes[0]!.pairs[0]!.paths).toEqual([]);
  });

  it("never reads as indirect while nothing has been fetched", () => {
    // Absence of data is not data, and that rule outranks a path found in it.
    const out = assessWithPaths([route()], [], [], { "SFO>NRT": [path(["ICN"], ["alaska"])] });
    expect(out.routes[0]!.verdict).toBe("unknown");
  });

  it("honours the route's own program filter on paths too", () => {
    // A path through a program the route excludes is not a path the route can
    // use, exactly as a direct edge through one is not reach.
    const paths = { "SFO>NRT": [path(["ICN"], ["alaska"])] };
    expect(
      assessWithPaths([route({ programs: ["aadvantage"] })], [], ["alaska"], paths).routes[0]!
        .verdict,
    ).toBe("gap");
    expect(
      assessWithPaths([route({ programs: ["alaska"] })], [], ["alaska"], paths).routes[0]!.verdict,
    ).toBe("indirect");
  });

  it("caps the paths it carries — the panel names hubs, it does not plan trips", () => {
    const many = ["ICN", "DOH", "SIN", "BKK", "IST"].map((hub) => path([hub], ["alaska"]));
    const out = assessWithPaths([route()], [], ["alaska"], { "SFO>NRT": many });
    expect(out.routes[0]!.pairs[0]!.paths).toHaveLength(REACH_PATHS_PER_PAIR);
  });

  it("ranks a route by its worst pair, with indirect between gap and ok", () => {
    const multi = route({ origins: ["SEA", "PDX"], destinations: ["NRT"] });
    const graph = [pair("SEA", "NRT", "alaska")];

    // One pair flown, one only reachable with a stop -> the route is indirect.
    expect(
      assessWithPaths([multi], graph, ["alaska"], { "PDX>NRT": [path(["ICN"], ["alaska"])] })
        .routes[0]!.verdict,
    ).toBe("indirect");

    // One pair unreachable at all outranks the indirect one.
    const three = route({ origins: ["SEA", "PDX", "SFO"], destinations: ["NRT"] });
    expect(
      assessWithPaths([three], graph, ["alaska"], { "PDX>NRT": [path(["ICN"], ["alaska"])] })
        .routes[0]!.verdict,
    ).toBe("gap");
  });

  it("marks a gap the deep-check budget skipped rather than exhausted", () => {
    // "We stopped looking" and "there is nothing there" are different claims,
    // and a capped sweep that cannot tell them apart reads as an exhaustive one.
    const out = assessWithPaths([route()], [], ["alaska"], {}, {
      deepSkipped: new Set(["SFO>NRT"]),
      deepCheckedPairs: 12,
      deepPairLimit: 12,
    });
    expect(out.routes[0]!.pairs[0]!.deepCheckSkipped).toBe(true);
    expect(out.deepCheckedPairs).toBe(12);
    expect(out.deepPairLimit).toBe(12);
  });

  it("never marks a pair it answered as skipped", () => {
    const out = assessWithPaths([route()], [pair("SFO", "NRT", "alaska")], ["alaska"], {}, {
      deepSkipped: new Set(["SFO>NRT"]),
    });
    expect(out.routes[0]!.pairs[0]!.deepCheckSkipped).toBe(false);
  });
});
