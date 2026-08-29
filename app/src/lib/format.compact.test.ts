import { describe, expect, it } from "vitest";
import { compactCount } from "./format";

describe("compactCount", () => {
  // The app bar is the whole reason this exists: the D1 chips read
  // `remaining/limit` against ceilings of 5,000,000 and 100,000, and the long
  // forms do not fit beside four tabs and three controls.
  it.each([
    [0, "0"],
    [842, "842"],
    [999, "999"],
    [1_000, "1K"],
    [8_410, "8.4K"],
    [91_590, "91.6K"],
    [100_000, "100K"],
    [3_760_000, "3.8M"],
    [5_000_000, "5M"],
  ])("%i renders as %s", (n, expected) => {
    expect(compactCount(n)).toBe(expected);
  });
});
