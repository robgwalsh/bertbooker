import { describe, expect, it } from "vitest";
import type { AvailabilityResult, SearchParams } from "../types.js";
import { bookableCurrencies, filterForParams } from "./filter.js";

const params: SearchParams = {
  origin: "SEA",
  destination: "LAX",
  dateStart: "2026-09-01",
  dateEnd: "2026-09-30",
  minSeats: 2,
  kind: "flight",
};

const result = (o: Partial<AvailabilityResult> = {}): AvailabilityResult => ({
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
  source: "scraper:alaska",
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
});

describe("filterForParams currency handling", () => {
  it("drops a find no selected currency can reach", () => {
    const p = { ...params, currencies: ["chase_ur", "capital_one"] };
    expect(filterForParams([result()], p)).toHaveLength(0);
  });

  it("keeps that same find once its cash fare is known", () => {
    // This is the regression that made the feature invisible on exactly the
    // routes it exists for: an Alaska (Bilt-only) find under a Chase-filtered
    // route was dropped before its dollar price could be shown.
    const p = { ...params, currencies: ["chase_ur", "capital_one"] };
    const kept = filterForParams([result({ cashPriceCents: 25_203 })], p);
    expect(kept).toHaveLength(1);
  });

  it("returns the same object references it was given", () => {
    // PointsYeah pairs survivors back to their detail URLs by Set membership.
    const r = result({ cashPriceCents: 25_203 });
    expect(filterForParams([r], params)[0]).toBe(r);
  });

  it("still drops a find with no currency at all under bookableOnly", () => {
    expect(filterForParams([result({ bookableWith: [] })], params)).toHaveLength(0);
  });

  it("lets a cash fare satisfy bookableOnly on a program nothing transfers to", () => {
    // The Delta case in general form: no transfer partner, but a buyable fare.
    const orphan = result({ program: "delta", bookableWith: [], cashPriceCents: 41_200 });
    expect(filterForParams([orphan], params)).toHaveLength(1);
  });

  it("does not let a cash fare bypass the cabin or seat filters", () => {
    const r = result({ cashPriceCents: 25_203 });
    expect(filterForParams([r], { ...params, cabins: ["business"] })).toHaveLength(0);
    expect(filterForParams([r], { ...params, minSeats: 20 })).toHaveLength(0);
  });
});
