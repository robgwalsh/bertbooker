import { describe, expect, it } from "vitest";
import {
  chunkTone,
  daysInclusive,
  gapRanges,
  LABEL_MIN_FRACTION,
  rangeLabel,
  timelineSegments,
  uncheckedRanges,
} from "./chunkTimeline";
import type { ChunkState } from "./useRouteSearch";

const chunk = (over: Partial<ChunkState> & Pick<ChunkState, "start" | "end">): ChunkState => ({
  status: "pending",
  httpCalls: [],
  ...over,
});

/** The real shape a year's window plans as: four 90-day chunks and a stub.
 *  `chunkDateRange` tiles contiguously, at most 5 × 90 days. */
const YEAR: ChunkState[] = [
  chunk({ start: "2026-03-01", end: "2026-05-29" }),
  chunk({ start: "2026-05-30", end: "2026-08-27" }),
  chunk({ start: "2026-08-28", end: "2026-11-25" }),
  chunk({ start: "2026-11-26", end: "2027-02-23" }),
  chunk({ start: "2027-02-24", end: "2027-03-01" }),
];

describe("daysInclusive", () => {
  it("counts a single day as one", () => {
    expect(daysInclusive("2026-03-01", "2026-03-01")).toBe(1);
  });

  it("counts across a month boundary", () => {
    expect(daysInclusive("2026-03-01", "2026-05-29")).toBe(90);
  });

  it("counts across a year boundary", () => {
    expect(daysInclusive("2026-12-31", "2027-01-01")).toBe(2);
  });

  // The whole reason this goes through `Date.UTC` on the parsed parts. A
  // local-time `Date` shifts the calendar day west of Greenwich, which would
  // make a chunk's width depend on where the viewer is sitting.
  it("is independent of the local timezone", () => {
    expect(daysInclusive("2026-02-28", "2026-03-01")).toBe(2);
    expect(daysInclusive("2028-02-28", "2028-03-01")).toBe(3); // leap year
  });

  it("is 0 rather than NaN for an unparseable date", () => {
    expect(daysInclusive("", "2026-03-01")).toBe(0);
  });
});

describe("chunkTone", () => {
  // The load-bearing distinction in the whole panel: `empty` is an ANSWER,
  // everything below it is the absence of one. They must never share a tone.
  it("treats empty as an answer, not a gap", () => {
    expect(chunkTone({ status: "empty" })).toBe("answered");
  });

  it("treats every no-answer status as a gap", () => {
    for (const status of ["failed", "blocked", "challenged", "timeout"] as const) {
      expect(chunkTone({ status })).toBe("gap");
    }
  });

  it("separates a range that found something from one that did not", () => {
    expect(chunkTone({ status: "ok", offersFound: 12 })).toBe("found");
    expect(chunkTone({ status: "ok", offersFound: 0 })).toBe("answered");
  });

  it("leaves pending, skipped and running out of both", () => {
    expect(chunkTone({ status: "pending" })).toBe("pending");
    expect(chunkTone({ status: "skipped" })).toBe("pending");
    expect(chunkTone({ status: "running" })).toBe("running");
  });
});

describe("rangeLabel", () => {
  it("names the two months a range spans", () => {
    expect(rangeLabel("2026-03-01", "2026-05-29")).toBe("Mar–May");
  });

  it("names one month when the range sits inside it", () => {
    expect(rangeLabel("2026-03-01", "2026-03-14")).toBe("Mar");
  });
});

describe("timelineSegments", () => {
  it("spans the plan's first start to its last end", () => {
    const t = timelineSegments(YEAR);
    expect(t.spanStart).toBe("2026-03-01");
    expect(t.spanEnd).toBe("2027-03-01");
    expect(t.totalDays).toBe(366);
  });

  // Equal-width segments would be a lie about the last chunk, which is 6 days
  // against 90 in the shape `chunkDateRange` actually produces.
  it("weights segments by days, not by count", () => {
    const t = timelineSegments(YEAR);
    expect(t.segments.map((s) => s.days)).toEqual([90, 90, 90, 90, 6]);
    expect(t.segments[4]!.fraction).toBeLessThan(t.segments[0]!.fraction / 10);
  });

  it("has fractions summing to one", () => {
    const t = timelineSegments(YEAR);
    expect(t.segments.reduce((n, s) => n + s.fraction, 0)).toBeCloseTo(1, 10);
  });

  it("suppresses the label on a segment too narrow to hold one", () => {
    const t = timelineSegments(YEAR);
    expect(t.segments.slice(0, 4).every((s) => s.showLabel)).toBe(true);
    expect(t.segments[4]!.showLabel).toBe(false);
    expect(t.segments[4]!.fraction).toBeLessThan(LABEL_MIN_FRACTION);
  });

  it("marks a chunk that narrowed its own coverage claim", () => {
    const t = timelineSegments([chunk({ start: "2026-03-01", end: "2026-05-29", status: "ok", note: "paginated out" })]);
    expect(t.segments[0]!.narrowed).toBe(true);
  });

  it("is empty for an empty plan rather than throwing", () => {
    expect(timelineSegments([])).toEqual({
      segments: [],
      spanStart: "",
      spanEnd: "",
      totalDays: 0,
    });
  });
});

describe("gapRanges / uncheckedRanges", () => {
  const mixed: ChunkState[] = [
    chunk({ start: "2026-03-01", end: "2026-05-29", status: "ok", offersFound: 4 }),
    chunk({ start: "2026-05-30", end: "2026-08-27", status: "empty" }),
    chunk({ start: "2026-08-28", end: "2026-11-25", status: "blocked" }),
    chunk({ start: "2026-11-26", end: "2027-02-23", status: "pending" }),
  ];

  it("reports only the ranges that got no answer", () => {
    expect(gapRanges(mixed).map((c) => c.start)).toEqual(["2026-08-28"]);
  });

  it("reports only the ranges nobody reached", () => {
    expect(uncheckedRanges(mixed).map((c) => c.start)).toEqual(["2026-11-26"]);
  });
});
