import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_SLACK_MI,
  MAX_DETOUR,
  haversineMi,
  rankPaths,
  type Coord,
  type PathCandidate,
} from "./graphPaths.js";

// `rankPaths` turns raw self-join rows into the answer "here is how you'd get
// there". The rows themselves are not the answer: SFO->KTM returns seventeen of
// them for seven hubs, and the same hub arrives once per program flying it.

const AIRPORTS: Record<string, Coord> = {
  SFO: { lat: 37.6188, lon: -122.375 },
  KTM: { lat: 27.6966, lon: 85.3591 },
  ICN: { lat: 37.4691, lon: 126.451 },
  DOH: { lat: 25.2731, lon: 51.608 },
  SIN: { lat: 1.35019, lon: 103.994 },
  // Deliberately the wrong way round the planet from SFO->KTM.
  SYD: { lat: -33.9461, lon: 151.177 },
  SEA: { lat: 47.4489, lon: -122.309 },
  // Short haul, for the absolute-slack rule: PDX->GEG is ~280 mi and the real
  // connection through BOI is ~630, a ratio of 2.25.
  PDX: { lat: 45.5887, lon: -122.598 },
  GEG: { lat: 47.6199, lon: -117.534 },
  BOI: { lat: 43.5644, lon: -116.223 },
  // In no `airports` row — the one graph airport that really is missing.
  NOWHERE: { lat: Number.NaN, lon: Number.NaN },
};

const coords = (code: string): Coord | null =>
  code === "NOWHERE" ? null : (AIRPORTS[code] ?? null);

/** alaska/united map to programs; smiles is real and knowingly unmapped. */
const programOf = (source: string): string | null =>
  ({ alaska: "alaska", united: "mileageplus", qatar: "avios", british: "avios" })[source] ?? null;

const via = (hub: string, ...legSources: string[]): PathCandidate => ({
  via: [hub],
  legSources,
});

const rank = (candidates: PathCandidate[], over: Partial<Parameters<typeof rankPaths>[1]> = {}) =>
  rankPaths(candidates, {
    origin: "SFO",
    destination: "KTM",
    coords,
    programOf,
    stops: 1,
    ...over,
  });

describe("haversineMi", () => {
  it("measures in statute miles, the unit the graph stores", () => {
    // SFO->KTM's published great circle is ~7,600 statute miles. Getting the
    // unit wrong would make every detour ratio wrong by 1.6 and silently pass
    // or fail every path.
    expect(haversineMi(AIRPORTS.SFO!, AIRPORTS.KTM!)).toBeGreaterThan(7400);
    expect(haversineMi(AIRPORTS.SFO!, AIRPORTS.KTM!)).toBeLessThan(7800);
  });

  it("is zero for a point against itself, and symmetric", () => {
    expect(haversineMi(AIRPORTS.SFO!, AIRPORTS.SFO!)).toBe(0);
    expect(haversineMi(AIRPORTS.SFO!, AIRPORTS.ICN!)).toBeCloseTo(
      haversineMi(AIRPORTS.ICN!, AIRPORTS.SFO!),
      6,
    );
  });

  it("crosses the antimeridian the short way", () => {
    // SFO->ICN is ~5,650 mi going west. A naive longitude subtraction would
    // route it the long way round and roughly double it.
    expect(haversineMi(AIRPORTS.SFO!, AIRPORTS.ICN!)).toBeLessThan(6000);
  });
});

describe("rankPaths", () => {
  it("collapses the rows for one hub into a single path", () => {
    // The join returns one row per (hub, source-per-leg). Seven hubs arriving as
    // seventeen rows is the measured shape of SFO->KTM; the pane must show
    // seven.
    const out = rank([
      via("ICN", "alaska", "alaska"),
      via("ICN", "united", "united"),
      via("DOH", "qatar", "qatar"),
    ]);
    expect(out.paths.map((p) => p.via[0])).toEqual(["ICN", "DOH"]);
  });

  it("names the programs whose network covers EVERY leg", () => {
    // alaska flies both legs; united only the first. Only alaska can plausibly
    // ticket the whole thing as one award.
    const out = rank([via("ICN", "alaska", "alaska"), via("ICN", "united", "alaska")]);
    expect(out.paths[0]!.programs).toEqual(["alaska"]);
    expect(out.paths[0]!.mixed).toBe(false);
  });

  it("intersects on the PROGRAM, not the source", () => {
    // qatar and british are different networks and both are Avios. A traveller
    // holding Avios can book across them, so this is one award, not two.
    const out = rank([via("DOH", "qatar", "british")]);
    expect(out.paths[0]!.programs).toEqual(["avios"]);
    expect(out.paths[0]!.mixed).toBe(false);
  });

  it("marks a path no single program covers as mixed", () => {
    // Real, and materially weaker: one award per leg, two currencies, and the
    // connection at the traveller's own risk.
    const out = rank([via("ICN", "alaska", "united")]);
    expect(out.paths[0]!.mixed).toBe(true);
    expect(out.paths[0]!.programs).toEqual([]);
  });

  it("sorts one-program paths ahead of mixed ones however much shorter the mix", () => {
    // The difference between them is one award and two, not a few hundred miles.
    const out = rank([
      via("ICN", "alaska", "united"), // mixed, and the SHORTEST
      via("SIN", "alaska", "alaska"), // one program, and much longer
    ]);
    expect(out.paths.map((p) => p.via[0])).toEqual(["SIN", "ICN"]);
  });

  it("sorts same-tier paths by total distance", () => {
    const out = rank([
      via("SIN", "alaska", "alaska"),
      via("ICN", "alaska", "alaska"),
      via("DOH", "alaska", "alaska"),
    ]);
    expect(out.paths.map((p) => p.via[0])).toEqual(["ICN", "DOH", "SIN"]);
    expect(out.paths[0]!.totalMi).toBeLessThan(out.paths[1]!.totalMi!);
  });

  it("drops a hub on the wrong side of the world", () => {
    // SFO->SYD->KTM is 7,400 + 5,600 miles against a 7,600-mile great circle.
    // Without a budget the list fills with these and the good routing is buried.
    const out = rank([via("ICN", "alaska", "alaska"), via("SYD", "alaska", "alaska")]);
    expect(out.paths.map((p) => p.via[0])).toEqual(["ICN"]);
  });

  it("allows a longer detour at two stops than at one", () => {
    expect(MAX_DETOUR[2]).toBeGreaterThan(MAX_DETOUR[1]);
    const candidates: PathCandidate[] = [{ via: ["ICN", "DOH"], legSources: ["a", "a", "a"] }];
    // Both depths keep this one; the point is that the constant is depth-aware
    // rather than a single number two stops has to squeeze under.
    expect(rank(candidates, { stops: 2 }).paths).toHaveLength(1);
  });

  it("judges a SHORT pair by absolute slack, not by ratio", () => {
    // PDX->GEG is ~280 mi and its real connection through Boise is ~630 — a
    // ratio of 2.25, well past MAX_DETOUR, and an entirely ordinary regional
    // routing. A ratio-only budget would reject every short-haul connection.
    const out = rankPaths([via("BOI", "alaska", "alaska")], {
      origin: "PDX",
      destination: "GEG",
      coords,
      programOf,
      stops: 1,
    });
    expect(out.paths).toHaveLength(1);
    const direct = haversineMi(AIRPORTS.PDX!, AIRPORTS.GEG!);
    expect(out.paths[0]!.detour).toBeGreaterThan(MAX_DETOUR[1]);
    expect(out.paths[0]!.totalMi).toBeLessThanOrEqual(direct + ABSOLUTE_SLACK_MI);
  });

  it("refuses to guess a total when a leg's distance is unknown", () => {
    // A partial sum presented as a total would understate the detour and let a
    // path through the budget it should have failed.
    const out = rank([via("NOWHERE", "alaska", "alaska")]);
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0]!.totalMi).toBeNull();
    expect(out.paths[0]!.detour).toBeNull();
    expect(out.paths[0]!.legs[0]!.distanceMi).toBeNull();
  });

  it("sorts an unknown total LAST rather than first", () => {
    const out = rank([via("NOWHERE", "alaska", "alaska"), via("SIN", "alaska", "alaska")]);
    expect(out.paths.map((p) => p.via[0])).toEqual(["SIN", "NOWHERE"]);
  });

  it("keeps everything when the asked pair itself has no coordinates", () => {
    // No great circle means no budget, and inventing one would be a verdict the
    // data does not support.
    const out = rankPaths([via("SYD", "alaska", "alaska")], {
      origin: "NOWHERE",
      destination: "KTM",
      coords,
      programOf,
      stops: 1,
    });
    expect(out.paths).toHaveLength(1);
  });

  it("reports an unmapped source as reach it cannot book", () => {
    const out = rank([via("ICN", "smiles", "smiles")]);
    expect(out.paths[0]!.programs).toEqual([]);
    expect(out.paths[0]!.unmappedSources).toEqual(["smiles"]);
    // Not `mixed`: one network really does cover the whole path. It is simply
    // one this app holds no currency for.
    expect(out.paths[0]!.mixed).toBe(false);
  });

  it("rejects a hub that is one of the endpoints", () => {
    // The bulk query answers many pairs at once, so a hub that is fine for one
    // asked pair can be an endpoint of another.
    expect(rank([via("SFO", "alaska", "alaska")]).paths).toEqual([]);
    expect(rank([via("KTM", "alaska", "alaska")]).paths).toEqual([]);
  });

  it("rejects a path that visits the same hub twice", () => {
    const out = rank([{ via: ["ICN", "ICN"], legSources: ["alaska", "alaska", "alaska"] }], {
      stops: 2,
    });
    expect(out.paths).toEqual([]);
  });

  it("ignores a row with fewer sources than legs rather than under-filling a leg", () => {
    // An under-filled leg would make a mixed path look like a one-program one,
    // which is the one error here that costs money.
    const out = rank([via("ICN", "alaska"), via("ICN", "alaska", "united")]);
    expect(out.paths[0]!.legs[1]!.sources).toEqual(["united"]);
    expect(out.paths[0]!.mixed).toBe(true);
  });

  it("states truncation rather than quietly shortening the list", () => {
    const many = ["ICN", "DOH", "SIN"].map((hub) => via(hub, "alaska", "alaska"));
    const out = rank(many, { maxPaths: 2 });
    expect(out.paths).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(rank(many, { maxPaths: 3 }).truncated).toBe(false);
  });

  it("carries the legs as the searchable pairs they are", () => {
    // The whole point of reporting legs rather than a route: each one is a pair
    // a search can ask about, and the asked pair is not.
    const out = rank([via("ICN", "alaska", "alaska")]);
    expect(out.paths[0]!.legs.map((l) => `${l.origin}>${l.destination}`)).toEqual([
      "SFO>ICN",
      "ICN>KTM",
    ]);
  });

  it("builds a two-stop chain in order", () => {
    const out = rankPaths([{ via: ["SEA", "ICN"], legSources: ["alaska", "alaska", "alaska"] }], {
      origin: "SFO",
      destination: "KTM",
      coords,
      programOf,
      stops: 2,
    });
    expect(out.paths[0]!.legs.map((l) => `${l.origin}>${l.destination}`)).toEqual([
      "SFO>SEA",
      "SEA>ICN",
      "ICN>KTM",
    ]);
    expect(out.paths[0]!.via).toEqual(["SEA", "ICN"]);
  });

  it("drops a two-stop chain that doubles back, even at the looser budget", () => {
    // SFO->DOH->ICN->KTM flies past Nepal to Doha, back to Seoul, and down
    // again: ~15,700 mi against a 7,600-mile great circle.
    const out = rankPaths([{ via: ["DOH", "ICN"], legSources: ["alaska", "alaska", "alaska"] }], {
      origin: "SFO",
      destination: "KTM",
      coords,
      programOf,
      stops: 2,
    });
    expect(out.paths).toEqual([]);
  });

  it("answers an empty candidate list with an empty, untruncated result", () => {
    expect(rank([])).toEqual({ paths: [], truncated: false });
  });
});
