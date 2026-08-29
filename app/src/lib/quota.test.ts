import { describe, expect, it } from "vitest";
import type { D1UsagePage } from "../api";
import { D1_ROWS_READ_METER, D1_ROWS_WRITTEN_METER, summarizeD1Usage } from "./quota";

function page(rowsRead: number, rowsWritten = 0): D1UsagePage {
  return {
    usage: {
      day: "2026-08-28",
      observedAt: Date.UTC(2026, 7, 28, 12, 0, 0),
      rowsRead,
      rowsWritten,
      readLimit: 5_000_000,
      writtenLimit: 100_000,
    },
  };
}

describe("summarizeD1Usage", () => {
  // The distinction the whole feature turns on. An absent payload draws NO
  // chip; a zeroed one would draw a full allowance, which is the wrong
  // reassurance when the truth is that Cloudflare could not be asked.
  it("draws nothing when Cloudflare could not be asked", () => {
    expect(summarizeD1Usage(undefined)).toEqual([]);
    expect(summarizeD1Usage({})).toEqual([]);
  });

  it("counts down, and keeps the observed spend for the tooltip", () => {
    const [read, written] = summarizeD1Usage(page(1_240_000, 8_410));
    expect(read).toMatchObject({
      source: D1_ROWS_READ_METER,
      used: 1_240_000,
      remaining: 3_760_000,
      limit: 5_000_000,
    });
    expect(written).toMatchObject({
      source: D1_ROWS_WRITTEN_METER,
      used: 8_410,
      remaining: 91_590,
      limit: 100_000,
    });
  });

  it("clamps an overspent meter to zero rather than showing a negative", () => {
    // This is not hypothetical: 0005_read_indexes.sql records 18,357,629 rows
    // read in a day against this same 5,000,000 ceiling.
    const read = summarizeD1Usage(page(18_357_629))[0]!;
    expect(read.remaining).toBe(0);
    expect(read.used).toBe(18_357_629);
    expect(read.pct).toBe(0);
    expect(read.tone).toBe("low");
  });

  describe("tone thresholds match the seats.aero chip's, so one glance rule covers all three", () => {
    // pct is REMAINING/limit, so a low percentage is an alarming one.
    it.each([
      [5_000_000, "low"], // nothing left
      [4_550_000, "low"], // 9% left
      [4_500_000, "warn"], // 10% left — the boundary belongs to warn
      [3_800_000, "warn"], // 24% left
      [3_750_000, "ok"], // 25% left — the boundary belongs to ok
      [0, "ok"], // untouched
    ])("%i rows read reads as %s", (used, tone) => {
      expect(summarizeD1Usage(page(used))[0]!.tone).toBe(tone);
    });
  });

  it("labels both meters for a human", () => {
    expect(summarizeD1Usage(page(1)).map((s) => s.label)).toEqual([
      "D1 rows read",
      "D1 rows written",
    ]);
  });
});
