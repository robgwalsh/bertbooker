import { describe, expect, it } from "vitest";
import { parseD1Analytics, utcDay } from "./cloudflareAnalytics.js";

/** A well-formed response with one account and one day's group. */
function body(sum: unknown) {
  return {
    data: {
      viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum }] }] },
    },
  };
}

describe("parseD1Analytics", () => {
  it("reads the day's totals", () => {
    expect(parseD1Analytics(body({ rowsRead: 1_234_567, rowsWritten: 8_410 }))).toEqual({
      rowsRead: 1_234_567,
      rowsWritten: 8_410,
    });
  });

  it("sums every group and every account, because the ceiling is account-wide", () => {
    const json = {
      data: {
        viewer: {
          accounts: [
            {
              d1AnalyticsAdaptiveGroups: [
                { sum: { rowsRead: 100, rowsWritten: 1 } },
                { sum: { rowsRead: 200, rowsWritten: 2 } },
              ],
            },
            {
              d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 400, rowsWritten: 4 } }],
            },
          ],
        },
      },
    };
    expect(parseD1Analytics(json)).toEqual({ rowsRead: 700, rowsWritten: 7 });
  });

  it("reads a genuine zero, which is not the same as an absent one", () => {
    expect(parseD1Analytics(body({ rowsRead: 0, rowsWritten: 0 }))).toEqual({
      rowsRead: 0,
      rowsWritten: 0,
    });
  });

  // The whole point of the function. Every one of these must be `undefined` and
  // never `{ rowsRead: 0 }`: the SPA draws no chip for an absent meter, but
  // draws a FULL allowance for a zero — the one reading that says "nothing to
  // worry about" at exactly the moment nobody knows.
  describe("never invents a zero", () => {
    it("refuses a body carrying GraphQL errors, even with partial data", () => {
      const json = {
        ...body({ rowsRead: 5, rowsWritten: 5 }),
        errors: [{ message: "nope" }],
      };
      expect(parseD1Analytics(json)).toBeUndefined();
    });

    it.each([
      ["a null field", body({ rowsRead: null, rowsWritten: 10 })],
      ["a missing field", body({ rowsWritten: 10 })],
      ["a string field", body({ rowsRead: "1000", rowsWritten: 10 })],
      ["a negative field", body({ rowsRead: -1, rowsWritten: 10 })],
      ["no sum at all", body(undefined)],
      ["no groups", { data: { viewer: { accounts: [{}] } } }],
      [
        "an empty group list",
        { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } },
      ],
      ["no accounts", { data: { viewer: { accounts: [] } } }],
      ["no viewer", { data: {} }],
      ["an empty object", {}],
      ["null", null],
      ["a string", "unauthorized"],
    ])("refuses %s", (_label, json) => {
      expect(parseD1Analytics(json)).toBeUndefined();
    });
  });
});

describe("utcDay", () => {
  it("is UTC, not the caller's clock — that is when the allowance resets", () => {
    expect(utcDay(Date.UTC(2026, 7, 28, 23, 59, 59))).toBe("2026-08-28");
    expect(utcDay(Date.UTC(2026, 7, 29, 0, 0, 0))).toBe("2026-08-29");
  });
});
