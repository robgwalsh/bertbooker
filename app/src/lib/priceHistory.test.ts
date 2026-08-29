import { describe, expect, it } from "vitest";
import type { PricePoint } from "../api";
import { holdToNow, priceSeries, sparkline, vsBest, type SeriesPoint } from "./priceHistory";

function point(at: number, miles: number | null): PricePoint {
  return {
    miles_cost: miles,
    seats_available: miles == null ? null : 2,
    cash_fees_cents: null,
    fees_currency: null,
    source: "seatsaero",
    source_fetched_at: miles == null ? null : at,
    captured_at: at,
  };
}

const at = (t: number, miles: number | null): SeriesPoint => ({
  at: t,
  miles,
  seats: miles == null ? null : 2,
});

describe("priceSeries", () => {
  it("sorts oldest first and keeps one entry per timestamp", () => {
    const s = priceSeries([point(30, 60000), point(10, 50000), point(10, 55000)]);
    expect(s.map((p) => [p.at, p.miles])).toEqual([
      [10, 55000],
      [30, 60000],
    ]);
  });

  it("carries a gone observation through as a null price", () => {
    expect(priceSeries([point(10, null)])).toEqual([{ at: 10, miles: null, seats: null }]);
  });
});

describe("holdToNow", () => {
  // Points are written on change, so the last one is the CURRENT price, not the
  // moment the data stopped.
  it("extends the last observation to now", () => {
    expect(holdToNow([at(10, 50000)], 40)).toEqual([at(10, 50000), at(40, 50000)]);
  });

  it("holds a gone observation as still gone", () => {
    expect(holdToNow([at(10, null)], 40).at(-1)!.miles).toBeNull();
  });

  it("adds nothing when the series already reaches now", () => {
    expect(holdToNow([at(40, 50000)], 40)).toEqual([at(40, 50000)]);
    expect(holdToNow([], 40)).toEqual([]);
  });
});

describe("sparkline", () => {
  it("steps between observations rather than interpolating", () => {
    const { segments } = sparkline([at(0, 100), at(10, 200)], 100, 50);
    expect(segments).toHaveLength(1);
    // H then V: the price held, then moved.
    expect(segments[0]).toBe("M 0 50 H 100 V 0");
  });

  // The whole reason `segments` is plural.
  it("breaks the line at a gone point instead of bridging or zeroing it", () => {
    const { segments } = sparkline([at(0, 100), at(5, null), at(10, 200)], 100, 50);
    expect(segments).toHaveLength(2);
    expect(segments.join(" ")).not.toContain("NaN");
  });

  // Centred, not at the bottom: one observation is also a flat series, so it
  // has no price axis to be low or high on.
  it("draws a lone observation as a zero-length line", () => {
    expect(sparkline([at(0, 100)], 100, 50).segments).toEqual(["M 0 25 L 0 25"]);
  });

  it("centres a flat series rather than pinning it to an edge", () => {
    const { segments, min, max } = sparkline([at(0, 100), at(10, 100)], 100, 50);
    expect(min).toBe(100);
    expect(max).toBe(100);
    expect(segments[0]).toBe("M 0 25 H 100 V 25");
  });

  it("reports the current price as null while the slot is gone", () => {
    expect(sparkline([at(0, 100), at(10, null)], 100, 50).last).toBeNull();
  });

  it("returns no segments for an empty or all-gone series", () => {
    expect(sparkline([], 100, 50)).toEqual({ segments: [], min: 0, max: 0, last: null });
    expect(sparkline([at(0, null)], 100, 50).segments).toEqual([]);
  });
});

describe("vsBest", () => {
  it("says nothing when no history exists", () => {
    expect(vsBest(50000, null)).toBeNull();
    expect(vsBest(50000, undefined)).toBeNull();
    expect(vsBest(50000, 0)).toBeNull();
  });

  it("reads the current price as the best when it matches or beats the record", () => {
    expect(vsBest(50000, 50000)).toEqual({ isBest: true, pctAbove: 0 });
    expect(vsBest(45000, 50000)).toEqual({ isBest: true, pctAbove: 0 });
  });

  it("gives the premium over the cheapest ever seen", () => {
    expect(vsBest(60000, 50000)).toEqual({ isBest: false, pctAbove: 20 });
    expect(vsBest(55000, 50000)).toEqual({ isBest: false, pctAbove: 10 });
  });
});
