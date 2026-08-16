import { describe, expect, it } from "vitest";
import {
  basemapPaths,
  decodeRing,
  frameFor,
  greatCircle,
  isSamePath,
  project,
  routeArc,
  toPercent,
  unwrapLon,
  unwrapPaths,
  unwrapStops,
  worldOffsets,
  type GeoPoint,
} from "./routeMapGeometry";

const SEA: GeoPoint = { lon: -122.309, lat: 47.449 };
const LAX: GeoPoint = { lon: -118.408, lat: 33.942 };
const NRT: GeoPoint = { lon: 140.386, lat: 35.765 };
const LHR: GeoPoint = { lon: -0.461, lat: 51.477 };
const SFO: GeoPoint = { lon: -122.375, lat: 37.619 };
const SIN: GeoPoint = { lon: 103.991, lat: 1.364 };
const ICN: GeoPoint = { lon: 126.451, lat: 37.469 };

describe("unwrapLon", () => {
  it("leaves a longitude already near the reference alone", () => {
    expect(unwrapLon(-118.4, -122.3)).toBeCloseTo(-118.4, 6);
  });

  // The whole reason the widget can draw a Pacific route as one line: Tokyo is
  // stored at +140 but has to be drawn at -220 to sit LEFT of Seattle.
  it("carries a longitude across the antimeridian to stay near the reference", () => {
    expect(unwrapLon(140.4, -122.3)).toBeCloseTo(-219.6, 6);
  });

  it("is idempotent", () => {
    const once = unwrapLon(140.4, -122.3);
    expect(unwrapLon(once, -122.3)).toBeCloseTo(once, 6);
  });
});

describe("greatCircle", () => {
  it("starts and ends on its endpoints", () => {
    const arc = greatCircle(SEA, LAX, 24);
    expect(arc[0]!.lat).toBeCloseTo(SEA.lat, 4);
    expect(arc[0]!.lon).toBeCloseTo(SEA.lon, 4);
    expect(arc.at(-1)!.lat).toBeCloseTo(LAX.lat, 4);
    expect(arc.at(-1)!.lon).toBeCloseTo(LAX.lon, 4);
  });

  // The bend is the entire argument for drawing a map rather than a straight
  // line between two dots: SEA→NRT flies far north of both airports.
  it("bows poleward on a transpacific route", () => {
    const arc = greatCircle(SEA, NRT, 48);
    const highest = Math.max(...arc.map((p) => p.lat));
    expect(highest).toBeGreaterThan(Math.max(SEA.lat, NRT.lat) + 4);
  });

  it("never jumps a turn of longitude between samples", () => {
    const arc = greatCircle(SEA, NRT, 48);
    for (let i = 1; i < arc.length; i++) {
      expect(Math.abs(arc[i]!.lon - arc[i - 1]!.lon)).toBeLessThan(180);
    }
  });

  it("survives identical endpoints instead of dividing by zero", () => {
    const arc = greatCircle(SEA, { ...SEA }, 12);
    expect(arc.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true);
  });
});

describe("routeArc", () => {
  it("is nothing below two stops", () => {
    expect(routeArc([SEA])).toEqual([]);
    expect(routeArc([])).toEqual([]);
  });

  it("joins legs without repeating the shared airport", () => {
    const one = routeArc([SEA, LAX], 8);
    const two = routeArc([SEA, LAX, NRT], 8);
    expect(two).toHaveLength(one.length + 8);
  });

  // A connection is the point at which a naive per-leg unwrap would fold the
  // path back over itself.
  it("stays in one continuous longitude space across a connection", () => {
    const arc = routeArc([SEA, LAX, NRT], 24);
    for (let i = 1; i < arc.length; i++) {
      expect(Math.abs(arc[i]!.lon - arc[i - 1]!.lon)).toBeLessThan(180);
    }
    expect(arc.at(-1)!.lon).toBeLessThan(-180);
  });
});

describe("unwrapStops", () => {
  it("puts the stops in the same space the arc is drawn in", () => {
    const [sea, nrt] = unwrapStops([SEA, NRT]);
    expect(sea!.lon).toBeCloseTo(SEA.lon, 6);
    expect(nrt!.lon).toBeCloseTo(NRT.lon - 360, 6);
  });
});

describe("unwrapPaths", () => {
  // The bug: a round trip's two halves unwrapped separately land in different
  // copies of the world, and framing them together spans the earth twice.
  it("keeps a return leg in the same copy of the world as its outbound", () => {
    const [out, back] = unwrapPaths([
      [SFO, NRT, SIN],
      [SIN, ICN, SFO],
    ]);
    const lons = [...out!, ...back!].map((p) => p.lon);
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(180);
  });

  it("frames a divergent round trip on its region, not on the whole world", () => {
    const paths = unwrapPaths([
      [SFO, NRT, SIN],
      [SIN, ICN, SFO],
    ]);
    const frame = frameFor(paths.flatMap((p) => routeArc(p)), 232 / 184);
    expect(frame.width / frame.kx).toBeLessThan(220);
  });

  it("leaves a single path exactly as unwrapStops would", () => {
    expect(unwrapPaths([[SEA, NRT]])[0]).toEqual(unwrapStops([SEA, NRT]));
  });

  it("handles a return that retraces the outbound", () => {
    const [out, back] = unwrapPaths([
      [SEA, NRT],
      [NRT, SEA],
    ]);
    expect(back![0]!.lon).toBeCloseTo(out![1]!.lon, 6);
    expect(back![1]!.lon).toBeCloseTo(out![0]!.lon, 6);
  });
});

describe("frameFor", () => {
  const ASPECT = 232 / 132;

  it("matches the box's aspect exactly, so the projection stays uniform", () => {
    const frame = frameFor(routeArc(unwrapStops([SEA, NRT])), ASPECT);
    expect(frame.width / frame.height).toBeCloseTo(ASPECT, 6);
  });

  it("contains every point it was framed on", () => {
    const arc = routeArc(unwrapStops([SEA, LAX, NRT]));
    const frame = frameFor(arc, ASPECT);
    for (const p of arc) {
      const { left, top } = toPercent(p, frame);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(100);
    }
  });

  // Framing a short hop on its own bounding box gives two dots on a nameless
  // stretch of coast. The floor is what makes every route read as somewhere.
  it("holds a minimum span so a short hop still shows its region", () => {
    const frame = frameFor(routeArc(unwrapStops([SEA, LAX])), ASPECT);
    const degreesOfLongitude = frame.width / frame.kx;
    expect(degreesOfLongitude).toBeGreaterThan(30);
  });

  it("leaves the endpoints clear of the edges", () => {
    const stops = unwrapStops([SEA, LHR]);
    const frame = frameFor(routeArc(stops), ASPECT);
    for (const p of stops) {
      const { left } = toPercent(p, frame);
      expect(left).toBeGreaterThan(6);
      expect(left).toBeLessThan(94);
    }
  });

  // The other side of the same margin: `PADDING` alone left the route floating
  // in ocean, so `ZOOM` pulls the frame back in. Both bounds are asserted
  // because the useful range is narrow — too tight and the arc gets cropped,
  // too loose and the map stops being about the route.
  it("crops in on the route rather than showing the padding in full", () => {
    const stops = unwrapStops([SEA, LHR]);
    const frame = frameFor(routeArc(stops), ASPECT);
    // Longitude is the content-driven axis for this route; the other is grown
    // to the box's aspect and so says nothing about the framing.
    const contentSpan = Math.abs(stops[1]!.lon - stops[0]!.lon);
    const shown = frame.width / frame.kx;
    expect(shown).toBeGreaterThan(contentSpan);
    expect(shown).toBeLessThan(contentSpan * 1.3);
  });

  it("is stable, so every row on the same route shares one cached basemap", () => {
    const a = frameFor(routeArc(unwrapStops([SEA, NRT])), ASPECT);
    const b = frameFor(routeArc(unwrapStops([SEA, NRT])), ASPECT);
    expect(a).toEqual(b);
  });

  it("does not stretch a polar frame sideways", () => {
    const frame = frameFor([{ lon: 0, lat: 88 }, { lon: 40, lat: 86 }], ASPECT);
    expect(frame.kx).toBeGreaterThanOrEqual(0.25);
  });

  it("survives an empty point set rather than producing NaN", () => {
    const frame = frameFor([], ASPECT);
    expect(Number.isFinite(frame.x)).toBe(true);
    expect(Number.isFinite(frame.width)).toBe(true);
    expect(frame.width).toBeGreaterThan(0);
  });
});

describe("project", () => {
  it("shrinks longitude by the frame's cosine so shapes keep their proportions", () => {
    const frame = frameFor([{ lon: -10, lat: 60 }, { lon: 10, lat: 60 }], 2);
    expect(project({ lon: 10, lat: 0 }, frame).x).toBeCloseTo(10 * frame.kx, 6);
    // Latitude is untouched and inverted — SVG's y grows downward.
    expect(project({ lon: 0, lat: 10 }, frame).y).toBeCloseTo(-10, 6);
  });
});

describe("worldOffsets", () => {
  it("is one copy of the world for a frame inside the conventional bounds", () => {
    expect(worldOffsets(frameFor(routeArc(unwrapStops([SEA, LAX])), 1.7))).toEqual([0]);
  });

  // Without the extra copy, the Japanese coastline simply would not be drawn:
  // the frame is out at -220° and the stored geometry stops at -180°.
  it("repeats the world for a frame carried past the antimeridian", () => {
    expect(worldOffsets(frameFor(routeArc(unwrapStops([SEA, NRT])), 1.7))).toContain(-360);
  });
});

describe("isSamePath", () => {
  const path = (...codes: string[]) => codes.map((code) => ({ code }));

  // The bug this exists to kill: the round-trip table drew one map per leg, and
  // for the ordinary return that retraces the outbound both maps were identical.
  it("calls a plain reversed return the same path", () => {
    expect(isSamePath(path("SEA", "NRT"), path("NRT", "SEA"))).toBe(true);
    expect(isSamePath(path("SEA", "ORD", "LHR"), path("LHR", "ORD", "SEA"))).toBe(true);
  });

  it("separates a return that connects somewhere else", () => {
    expect(isSamePath(path("SEA", "NRT", "SIN"), path("SIN", "ICN", "SEA"))).toBe(false);
  });

  it("separates a nonstop out from a connecting return", () => {
    expect(isSamePath(path("SEA", "LHR"), path("LHR", "JFK", "SEA"))).toBe(false);
  });

  // Co-terminals: SFO→NRT out, HND→SFO back is a real pair and is NOT one line.
  it("separates a return from a different airport in the same city pair", () => {
    expect(isSamePath(path("SFO", "NRT"), path("HND", "SFO"))).toBe(false);
  });

  it("does not call a path the same as itself unreversed", () => {
    expect(isSamePath(path("SEA", "ORD", "LHR"), path("SEA", "ORD", "LHR"))).toBe(false);
  });
});

describe("decodeRing", () => {
  it("accumulates deltas back into degrees", () => {
    // Tenths of a degree: (10, -20) then +5, +5 → (15, -15).
    expect(decodeRing("10,-20,5,5")).toEqual([1, -2, 1.5, -1.5]);
  });
});

describe("basemapPaths", () => {
  const ASPECT = 232 / 132;

  it("draws land, lakes and borders for a frame over North America", () => {
    const paths = basemapPaths(frameFor(routeArc(unwrapStops([SEA, LAX])), ASPECT));
    expect(paths.land.startsWith("M")).toBe(true);
    expect(paths.land.length).toBeGreaterThan(100);
    expect(paths.borders.length).toBeGreaterThan(0);
    // Rings are closed; border lines are not.
    expect(paths.land).toContain("Z");
    expect(paths.borders).not.toContain("Z");
  });

  it("returns the same object for the same frame", () => {
    const frame = frameFor(routeArc(unwrapStops([SEA, LHR])), ASPECT);
    expect(basemapPaths(frame)).toBe(basemapPaths({ ...frame }));
  });

  // The cull is what keeps ~450 rings from being projected fifteen times a page.
  it("draws far less of the world for a regional frame than a global one", () => {
    const regional = basemapPaths(frameFor(routeArc(unwrapStops([SEA, LAX])), ASPECT));
    const global = basemapPaths(frameFor(
      [{ lon: -170, lat: -60 }, { lon: 170, lat: 70 }],
      ASPECT,
    ));
    expect(regional.land.length).toBeLessThan(global.land.length / 2);
  });

  it("finds Japanese coastline for a frame carried past the antimeridian", () => {
    const paths = basemapPaths(frameFor(routeArc(unwrapStops([SEA, NRT])), ASPECT));
    // Every drawn x is inside the frame's own span, including the repeated copy.
    expect(paths.land.length).toBeGreaterThan(1000);
  });
});
