import { describe, expect, it } from "vitest";
import { dollars, money } from "./format";

// `cash_fees_cents` is NOT always USD. seats.aero quotes Aeroplan in CAD and
// Korean Air out of Seoul in KRW, and a KRW figure read as dollars is wrong by
// more than an order of magnitude — on a number people book against.

describe("money", () => {
  it("is `dollars` for USD, and for no currency at all", () => {
    expect(money(2_560, "USD")).toBe(dollars(2_560));
    expect(money(2_560)).toBe(dollars(2_560));
    expect(money(2_560, null)).toBe(dollars(2_560));
  });

  it("does NOT divide a zero-minor-unit currency by 100", () => {
    // The bug this exists for: 2,400,000 KRW rendered through `dollars` reads as
    // $24,029.90 against a real value of roughly $1,700.
    const krw = money(2_400_000, "KRW");
    expect(krw).toContain("2,400,000");
    expect(krw).not.toContain("24,000.00");
  });

  it("keeps the minor unit for currencies that have one", () => {
    expect(money(7_920, "CAD")).toContain("79.20");
  });

  it("is case-insensitive about the code", () => {
    expect(money(7_920, "cad")).toBe(money(7_920, "CAD"));
  });

  it("falls back to dollars on a code Intl refuses, rather than throwing", () => {
    // A bad column value must narrow the answer, not blank the row.
    expect(money(2_560, "NOT_A_CODE")).toBe(dollars(2_560));
  });
});
