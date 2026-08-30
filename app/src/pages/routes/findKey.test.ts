import { describe, expect, it } from "vitest";
import type { Find } from "../../api";
import type { RoundTripPair } from "../../lib/roundtrip";
import type { Journey } from "../../lib/multiLeg";
import { findKey, journeyKey, pairKey } from "./findKey";

const find = (over: Partial<Find> = {}): Find => ({
  origin: "SFO",
  destination: "NRT",
  flight_date: "2026-03-14",
  program: "ana",
  cabin: "business",
  seats_available: 2,
  miles_cost: 60_000,
  cash_fees_cents: 1200,
  is_direct: 1,
  ...over,
});

describe("findKey", () => {
  it("separates finds that differ only in cabin", () => {
    // The snapshot row is keyed (route, date, program, cabin), so two cabins of
    // one flight are two rows and must be two elements.
    expect(findKey(find({ cabin: "economy" }), 0)).not.toBe(
      findKey(find({ cabin: "business" }), 0),
    );
  });

  it("separates finds that differ only in route", () => {
    // Co-terminal answers are real: an SFO→NRT search returns SFO→HND rows, and
    // the route is part of the collapse key precisely so they stay apart.
    expect(findKey(find({ destination: "HND" }), 0)).not.toBe(findKey(find(), 0));
  });

  it("separates the same find at two page offsets", () => {
    // This is what the index term is for. Without it a find that appears on two
    // pages of a paginated list is one key, and React reuses the element.
    expect(findKey(find(), 0)).not.toBe(findKey(find(), 15));
  });

  it("is stable for the same find at the same offset", () => {
    expect(findKey(find(), 3)).toBe(findKey(find(), 3));
  });

  it("does not collide when a field is empty", () => {
    // A separator-joined key can collide if a field is blank and the pieces run
    // together ("a" + "" + "b" vs "" + "ab"). Pinned so the separator survives.
    expect(findKey(find({ program: "", cabin: "x" }), 0)).not.toBe(
      findKey(find({ program: "x", cabin: "" }), 0),
    );
  });
});

describe("pairKey", () => {
  const pair = (over: Partial<RoundTripPair> = {}): RoundTripPair =>
    ({
      outbound: find(),
      inbound: find({ origin: "NRT", destination: "SFO", flight_date: "2026-03-21" }),
      cabin: "business",
      nights: 7,
      seats: 2,
      totalMiles: 120_000,
      totalFeesCents: 2400,
      ...over,
    }) as RoundTripPair;

  it("separates two returns paired with one outbound", () => {
    // The whole point of the pane: one outbound pairs with every return in the
    // nights range, so the inbound half of the key is what keeps them distinct.
    const a = pair();
    const b = pair({
      inbound: find({ origin: "NRT", destination: "SFO", flight_date: "2026-03-22" }),
      nights: 8,
    });
    expect(pairKey(a, 0)).not.toBe(pairKey(b, 0));
  });

  it("separates the same pair at two page offsets", () => {
    expect(pairKey(pair(), 0)).not.toBe(pairKey(pair(), 10));
  });

  it("is stable for the same pair at the same offset", () => {
    expect(pairKey(pair(), 2)).toBe(pairKey(pair(), 2));
  });
});

describe("journeyKey", () => {
  const leg = (origin: string, destination: string, over: Partial<Find> = {}) => ({
    find: find({ origin, destination, ...over }),
    gapMinutes: null,
  });

  const journey = (over: Partial<Journey> = {}): Journey => ({
    legs: [leg("SFO", "ICN"), leg("ICN", "KTM", { flight_date: "2026-03-15" })],
    via: ["ICN"],
    connectDays: 1,
    totalMiles: 60_000,
    totalFeesCents: 1_120,
    feesCurrency: "USD",
    seats: 2,
    programs: ["ana"],
    mixed: false,
    ...over,
  });

  it("separates two onward legs joined to one first leg", () => {
    // The whole point of the pane: one leg into a hub joins every leg out of it
    // in the window, so the second half of the key is what keeps them distinct.
    const a = journey();
    const b = journey({
      legs: [leg("SFO", "ICN"), leg("ICN", "KTM", { flight_date: "2026-03-16" })],
    });
    expect(journeyKey(a, 0)).not.toBe(journeyKey(b, 0));
  });

  it("separates two journeys through different hubs", () => {
    const viaDoh = journey({
      legs: [leg("SFO", "DOH"), leg("DOH", "KTM", { flight_date: "2026-03-15" })],
      via: ["DOH"],
    });
    expect(journeyKey(journey(), 0)).not.toBe(journeyKey(viaDoh, 0));
  });

  it("separates journeys that differ only in a leg's cabin", () => {
    // Cabin is PER LEG here, not per journey — economy to the hub under a
    // business long-haul is a different answer from business throughout.
    const economyFirst = journey({
      legs: [leg("SFO", "ICN", { cabin: "economy" }), leg("ICN", "KTM", { flight_date: "2026-03-15" })],
    });
    expect(journeyKey(journey(), 0)).not.toBe(journeyKey(economyFirst, 0));
  });

  it("separates journeys that differ only in a leg's program", () => {
    const mixed = journey({
      legs: [leg("SFO", "ICN"), leg("ICN", "KTM", { flight_date: "2026-03-15", program: "alaska" })],
      programs: ["ana", "alaska"],
      mixed: true,
    });
    expect(journeyKey(journey(), 0)).not.toBe(journeyKey(mixed, 0));
  });

  it("separates the same journey at two page offsets, and is stable at one", () => {
    expect(journeyKey(journey(), 0)).not.toBe(journeyKey(journey(), 10));
    expect(journeyKey(journey(), 2)).toBe(journeyKey(journey(), 2));
  });
});
