import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  chunkDateRange,
  daysBetween,
  effectiveSearchWindow,
  InvalidDateError,
  isIsoDate,
  planStrideDates,
  todayISO,
} from "./window.js";

// chunkDateRange / effectiveSearchWindow live here rather than beside one
// provider, because the horizon-clamp-then-tile shape is the same for all of
// them. Their optional parameters became required when they moved — a shared
// helper should not carry one provider's constants as defaults — so the calls
// below pass them explicitly. The 70-day horizons here are a short-horizon
// aggregator's, kept as a test case even though no such source ships now.

describe("addDaysISO", () => {
  it("crosses month and year boundaries", () => {
    expect(addDaysISO("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysISO("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles leap days", () => {
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysISO("2027-02-28", 1)).toBe("2027-03-01");
  });
});

describe("todayISO", () => {
  it("formats a timestamp as a UTC ISO date", () => {
    expect(todayISO(Date.parse("2026-08-06T23:30:00Z"))).toBe("2026-08-06");
  });
});

describe("daysBetween", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-08-01", "2026-08-31")).toBe(30);
    expect(daysBetween("2026-08-31", "2026-08-01")).toBe(-30);
    expect(daysBetween("2026-08-01", "2026-08-01")).toBe(0);
  });
});

describe("chunkDateRange", () => {
  it("returns a single chunk for a window at/under the max span", () => {
    expect(chunkDateRange("2026-08-01", "2026-08-31", 60, 6)).toEqual([
      { start: "2026-08-01", end: "2026-08-31" },
    ]);
  });

  it("splits a year into consecutive, non-overlapping, gap-free 60-day chunks", () => {
    const chunks = chunkDateRange("2026-08-05", "2027-08-05", 60, 12);
    expect(chunks.length).toBe(7); // ceil(366 / 60)
    expect(chunks[0]!.start).toBe("2026-08-05");
    expect(chunks[chunks.length - 1]!.end).toBe("2027-08-05");
    // No overlaps and no gaps: each chunk starts the day after the prior ends.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBe(addDaysISO(chunks[i - 1]!.end, 1));
    }
    for (const c of chunks) {
      expect(daysBetween(c.start, c.end)).toBeLessThanOrEqual(59);
    }
  });

  it("caps the number of chunks", () => {
    expect(chunkDateRange("2020-01-01", "2100-01-01", 60, 3)).toHaveLength(3);
  });

  it("emits one chunk per day at maxDays=1", () => {
    expect(chunkDateRange("2026-08-01", "2026-08-03", 1, 10)).toEqual([
      { start: "2026-08-01", end: "2026-08-01" },
      { start: "2026-08-02", end: "2026-08-02" },
      { start: "2026-08-03", end: "2026-08-03" },
    ]);
  });

  it("returns nothing for an inverted window", () => {
    expect(chunkDateRange("2026-09-01", "2026-08-01", 60, 6)).toEqual([]);
  });
});

describe("effectiveSearchWindow", () => {
  const today = "2026-08-05";

  it("clamps a year-long window to today .. today+horizon", () => {
    expect(effectiveSearchWindow("2026-08-05", "2027-08-05", today, 70)).toEqual({
      start: "2026-08-05",
      end: "2026-10-14", // 2026-08-05 + 70 days
    });
  });

  it("floors the start at today when the route started in the past", () => {
    expect(effectiveSearchWindow("2026-06-01", "2026-09-01", today, 70)).toEqual({
      start: "2026-08-05",
      end: "2026-09-01",
    });
  });

  it("keeps a wholly in-horizon window unchanged", () => {
    expect(effectiveSearchWindow("2026-08-20", "2026-09-10", today, 70)).toEqual({
      start: "2026-08-20",
      end: "2026-09-10",
    });
  });

  it("returns null when the whole window is beyond the horizon", () => {
    expect(effectiveSearchWindow("2026-11-15", "2027-02-01", today, 70)).toBeNull();
  });

  it("reaches much further with an airline-sized horizon", () => {
    // The whole point of the parameter: a 70-day horizon returns null here,
    // a 330-day one does not.
    expect(effectiveSearchWindow("2027-05-01", "2027-05-10", today, 70)).toBeNull();
    expect(effectiveSearchWindow("2027-05-01", "2027-05-10", today, 330)).toEqual({
      start: "2027-05-01",
      end: "2027-05-10",
    });
  });
});

describe("planStrideDates", () => {
  const today = "2026-08-05";

  it("dense-scans the near window then samples the far one", () => {
    const dates = planStrideDates("2026-08-05", "2027-07-01", today, 7, 10, 14);
    expect(dates).toHaveLength(14);
    // The first `scanDays` are consecutive.
    for (let i = 1; i < 7; i++) {
      expect(dates[i]).toBe(addDaysISO(dates[i - 1]!, 1));
    }
    // The remainder are spread out, not consecutive.
    expect(daysBetween(dates[7]!, dates[13]!)).toBeGreaterThan(14);
  });

  it("never exceeds maxDates", () => {
    expect(planStrideDates("2026-08-05", "2030-01-01", today, 7, 10, 5)).toHaveLength(5);
  });

  it("is deterministic for a given today", () => {
    const a = planStrideDates("2026-08-05", "2027-07-01", today, 7, 10, 14);
    const b = planStrideDates("2026-08-05", "2027-07-01", today, 7, 10, 14);
    expect(a).toEqual(b);
  });

  it("rotates its sampling phase as today advances, so runs walk the window", () => {
    const a = planStrideDates("2026-08-05", "2027-07-01", "2026-08-05", 0, 10, 8);
    const b = planStrideDates("2026-08-05", "2027-07-01", "2026-08-06", 0, 10, 8);
    // Same window, different day => a different set of sampled dates.
    expect(a).not.toEqual(b);
  });

  it("stays within the window and returns nothing when inverted", () => {
    const dates = planStrideDates("2026-08-05", "2026-08-20", today, 3, 5, 20);
    for (const d of dates) {
      expect(d >= "2026-08-05" && d <= "2026-08-20").toBe(true);
    }
    expect(planStrideDates("2026-09-01", "2026-08-01", today, 7, 10, 5)).toEqual([]);
  });
});

/**
 * The guard on the parse, which is the whole of a bug that could brick the app.
 *
 * `date_start`/`date_end` reach here straight off `tracked_routes`, and until
 * `POST /api/tracked-routes` validated them, anything at all could be stored.
 * `"garbage".split("-").map(Number)` is `[NaN]`, `Date.UTC(NaN, …)` is `NaN`,
 * and `new Date(NaN).toISOString()` throws `RangeError: Invalid time value` —
 * a message naming neither this function nor the value. Reached through
 * `routeFindsScope`, that was an opaque 500 on `GET /api/routes`, on every
 * search, and on every cron tick, permanently, for one bad POST.
 *
 * So these pin two things: that a non-date is refused rather than turned into
 * an `Invalid Date`, and that the refusal SAYS SO.
 */
describe("isIsoDate", () => {
  it("accepts the stored format and nothing else", () => {
    expect(isIsoDate("2026-08-22")).toBe(true);
    // Dates are compared as strings in SQL, so width is correctness, not style.
    expect(isIsoDate("2026-8-22")).toBe(false);
    expect(isIsoDate("2026-08-22T00:00:00Z")).toBe(false);
    expect(isIsoDate("garbage")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260822)).toBe(false);
  });
});

describe("addDaysISO / daysBetween reject a non-date", () => {
  it("throws a NAMED error rather than an opaque RangeError", () => {
    expect(() => addDaysISO("garbage", 1)).toThrow(InvalidDateError);
    // The message has to carry the value, or this is the same debugging dead
    // end wearing a different name.
    expect(() => addDaysISO("garbage", 1)).toThrow(/addDaysISO.*garbage/);
    expect(() => daysBetween("2026-08-22", "nope")).toThrow(InvalidDateError);
  });

  it("still does the arithmetic it always did", () => {
    expect(addDaysISO("2026-08-22", 1)).toBe("2026-08-23");
    expect(daysBetween("2026-08-22", "2026-08-25")).toBe(3);
  });

  it("refuses NaN quietly becoming a number", () => {
    // The quieter half: `daysBetween` returned NaN rather than throwing, and a
    // NaN day count propagates into pacing and chunking without complaint.
    expect(() => daysBetween("", "")).toThrow(InvalidDateError);
  });
});
