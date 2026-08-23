import { describe, expect, it } from "vitest";
import { rowIdParam } from "./params.js";

/**
 * Every `:id` handler used to write `Number(c.req.param("id"))` and bind the
 * result straight into SQL. `Number("abc")` is `NaN`, D1 compares that against
 * nothing, and so the handlers did not fail — they succeeded emptily. The worst
 * of them was DELETE, which answered `{ ok: true }` for a row that never
 * existed: a lie told with a 200.
 *
 * These pin the values a rowid is NOT, which is a longer list than "not NaN".
 */
describe("rowIdParam", () => {
  it("accepts a plain positive integer", () => {
    expect(rowIdParam("1")).toBe(1);
    expect(rowIdParam("4207")).toBe(4207);
  });

  it("refuses what is not a number at all", () => {
    expect(rowIdParam("abc")).toBeNull();
    expect(rowIdParam("12abc")).toBeNull();
    expect(rowIdParam(undefined)).toBeNull();
  });

  it("refuses an empty segment, which coerces to 0 rather than to NaN", () => {
    // The one that a `!Number.isNaN` guard would have let through.
    expect(rowIdParam("")).toBeNull();
    expect(rowIdParam("   ")).toBeNull();
  });

  it("refuses numbers that are not rowids", () => {
    // All perfectly good numbers; none of them is a rowid. SQLite rowids start
    // at 1, so 0 and negatives are not "not found", they are not asked.
    expect(rowIdParam("0")).toBeNull();
    expect(rowIdParam("-1")).toBeNull();
    expect(rowIdParam("1.5")).toBeNull();
    expect(rowIdParam("Infinity")).toBeNull();
    expect(rowIdParam("NaN")).toBeNull();
  });

  it("accepts exponent and hex spellings that ARE integers", () => {
    // Documenting rather than defending: these coerce to whole numbers, so they
    // are real rowids and binding them is harmless. Nothing depends on the
    // spelling — the value is what reaches SQL.
    expect(rowIdParam("1e3")).toBe(1000);
    expect(rowIdParam("0x10")).toBe(16);
  });
});
