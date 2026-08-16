import { describe, expect, it } from "vitest";
import type { AvailabilityResult } from "../domain/types.js";
import { bookableCurrencies } from "./filter.js";

const result =(o: Partial<AvailabilityResult> = {}): AvailabilityResult => ({
  origin: "SEA",
  destination: "LAX",
  flightDate: "2026-09-07",
  program: "alaska",
  cabin: "economy",
  seatsAvailable: 9,
  milesCost: 27_500,
  cashFeesCents: 560,
  feesCurrency: "USD",
  isDirect: true,
  segments: [],
  source: "seatsaero",
  sourceFetchedAt: 1,
  // Alaska takes transfers from Bilt and nothing else the couple holds.
  bookableWith: ["bilt"],
  ...o,
});

describe("bookableCurrencies", () => {
  it("is just the transfer partners when no fare is known", () => {
    expect(bookableCurrencies(result())).toEqual(["bilt"]);
  });

  it("adds every portal currency once a cash fare is known", () => {
    // The point of the whole feature: you can't move Chase points to Alaska, but
    // you can buy the same seat through Chase Travel.
    const withCash = bookableCurrencies(result({ cashPriceCents: 25_203 }));
    expect(withCash).toContain("bilt");
    expect(withCash).toContain("chase_ur");
    expect(withCash).toContain("capital_one");
    // "direct" has no portal — holding airline miles doesn't buy a revenue fare.
    expect(withCash).not.toContain("direct");
  });

  it("does not duplicate a currency that both transfers and has a portal", () => {
    const out = bookableCurrencies(result({ bookableWith: ["chase_ur"], cashPriceCents: 25_203 }));
    expect(out.filter((c) => c === "chase_ur")).toHaveLength(1);
  });

  it("reaches a program nothing transfers to, once its fare is known", () => {
    // The Delta case, and the strongest form of the rule: SkyMiles takes none
    // of the couple's currencies, so a cash fare is the ONLY thing that can
    // ever make a Delta seat bookable. A find with no transfer partner and no
    // fare is reachable by nothing at all.
    expect(bookableCurrencies(result({ program: "delta", bookableWith: [] }))).toEqual([]);
    const buyable = bookableCurrencies(
      result({ program: "delta", bookableWith: [], cashPriceCents: 41_200 }),
    );
    expect(buyable).toContain("chase_ur");
  });
});
