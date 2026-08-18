import { describe, expect, it } from "vitest";
import { graphBounds, graphEndpoints, graphLines } from "./routeGraph.js";
import type { RouteGraphEdge } from "../../../shared/src/wire/index.js";

const edge = (
  origin: string,
  destination: string,
  from: [number, number] | null = [37.6, -122.4],
  to: [number, number] | null = [35.8, 140.4],
): RouteGraphEdge => ({
  origin,
  destination,
  origin_lat: from?.[0] ?? null,
  origin_lon: from?.[1] ?? null,
  destination_lat: to?.[0] ?? null,
  destination_lon: to?.[1] ?? null,
});

describe("graphLines", () => {
  it("collapses a pair flown both ways into one line", () => {
    // Two overlapping arcs double the ink and carry no extra information.
    const { lines } = graphLines([edge("SFO", "NRT"), edge("NRT", "SFO", [35.8, 140.4], [37.6, -122.4])], 100);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.bidirectional).toBe(true);
  });

  it("marks a one-way pair as such", () => {
    const { lines } = graphLines([edge("SFO", "NRT")], 100);
    expect(lines[0]!.bidirectional).toBe(false);
  });

  it("drops an edge whose endpoint has no coordinates, and counts it", () => {
    // The airports table does not know every code seats.aero uses. Dropping is
    // right; dropping SILENTLY is not — the caption has to be able to say so.
    const { lines, unplottable } = graphLines([edge("SFO", "ZZZ", [37.6, -122.4], null)], 100);
    expect(lines).toHaveLength(0);
    expect(unplottable).toBe(1);
  });

  it("treats 0,0 as a placeholder rather than a point in the ocean", () => {
    const { lines, unplottable } = graphLines([edge("SFO", "XXX", [37.6, -122.4], [0, 0])], 100);
    expect(lines).toHaveLength(0);
    expect(unplottable).toBe(1);
  });

  it("caps the drawn set and counts what it left out", () => {
    const edges = Array.from({ length: 10 }, (_, i) => edge("SFO", `X${i}`));
    const { lines, omitted } = graphLines(edges, 4);
    expect(lines).toHaveLength(4);
    expect(omitted).toBe(6);
  });

  it("counts pairs so drawn + omitted actually adds up", () => {
    // The caption arithmetic. Counted against the DIRECTED edge count these
    // never reconcile, because a pair flown both ways is two edges and one
    // line — which is exactly how the first version of the caption came out
    // saying "2,500 of 8,130 drawn · 3,130 over the cap".
    const edges = [
      ...Array.from({ length: 10 }, (_, i) => edge("SFO", `X${i}`)),
      // ...and every one of them flown back again.
      ...Array.from({ length: 10 }, (_, i) => edge(`X${i}`, "SFO", [35.8, 140.4], [37.6, -122.4])),
    ];
    const { lines, pairs, omitted } = graphLines(edges, 4);
    expect(edges).toHaveLength(20);
    expect(pairs).toBe(10);
    expect(lines.length + omitted).toBe(pairs);
  });

  it("still merges a reverse edge once the cap is reached", () => {
    // The reverse of an already-drawn pair is not a new line, so it must not be
    // charged against the cap or counted as omitted.
    const edges = [edge("SFO", "NRT"), edge("NRT", "SFO", [35.8, 140.4], [37.6, -122.4])];
    const { lines, omitted } = graphLines(edges, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.bidirectional).toBe(true);
    expect(omitted).toBe(0);
  });
});

describe("graphBounds", () => {
  it("is null when there is nothing to fit", () => {
    // Read by the caller as "leave the view alone", not "zoom to nowhere".
    expect(graphBounds([])).toBeNull();
  });

  it("spans every endpoint", () => {
    const { lines } = graphLines([edge("SFO", "NRT")], 10);
    expect(graphBounds(lines)).toEqual([
      [35.8, -122.4],
      [37.6, 140.4],
    ]);
  });
});

describe("graphEndpoints", () => {
  it("lists each airport once however many arcs touch it", () => {
    const { lines } = graphLines([edge("SFO", "NRT"), edge("SFO", "HND", [37.6, -122.4], [35.5, 139.8])], 10);
    expect(graphEndpoints(lines).map((e) => e.code).sort()).toEqual(["HND", "NRT", "SFO"]);
  });
});
