import { describe, expect, it } from "vitest";
import type { Find, TrackedRoute } from "../api";
import {
  DEFAULT_MAX_CONNECT_DAYS,
  MAX_CONNECT_DAYS,
  stitchJourneys,
} from "./multiLeg";

// `stitchJourneys` answers "which stored leg into a hub joins which stored leg
// out of it" for a pair seats.aero holds no market on. SFO->KTM is the case
// throughout: in nobody's graph, so it never has a find of its own, while
// SFO->ICN and ICN->KTM are ordinary markets tracked as their own routes.

function find(p: Partial<Find> & Pick<Find, "origin" | "destination" | "flight_date">): Find {
  return {
    program: "alaska",
    cabin: "business",
    seats_available: 2,
    miles_cost: 60_000,
    cash_fees_cents: 560,
    is_direct: 1,
    source: "seatsaero",
    source_fetched_at: 1_760_000_000_000,
    ...p,
  };
}

function route(p: Partial<TrackedRoute> = {}): TrackedRoute {
  return {
    id: 1,
    origin: "SFO",
    destination: "KTM",
    origins: null,
    destinations: null,
    via: null,
    date_start: "2027-03-01",
    date_end: "2027-03-31",
    cabins: null,
    currencies: null,
    min_seats: 2,
    direct_only: 0,
    point_limit: null,
    round_trip: 0,
    last_checked_at: null,
    alerts_enabled: 0,
    alert_email: null,
    alert_on: null,
    alert_min_drop_pct: 5,
    alert_last_attempt_at: null,
    alert_last_digest_at: null,
    alert_consecutive_failures: 0,
    ...p,
  };
}

/** SFO -> ICN, the leg into the hub. */
const first = (date: string, p: Partial<Find> = {}) =>
  find({ origin: "SFO", destination: "ICN", flight_date: date, miles_cost: 35_000, ...p });
/** ICN -> KTM, the leg out of it. */
const second = (date: string, p: Partial<Find> = {}) =>
  find({ origin: "ICN", destination: "KTM", flight_date: date, miles_cost: 25_000, ...p });

const stitch = (finds: Find[], r: TrackedRoute = route(), opts = {}) =>
  stitchJourneys(r, finds, opts);

const chain = (j: { legs: { find: Find }[] }): string =>
  [j.legs[0]!.find.origin, ...j.legs.map((l) => l.find.destination)].join(">");

describe("stitchJourneys — which legs join", () => {
  it("joins a leg into a hub with a leg out of it", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys).toHaveLength(1);
    expect(chain(out.journeys[0]!)).toBe("SFO>ICN>KTM");
    expect(out.journeys[0]!.via).toEqual(["ICN"]);
    expect(out.hubs).toEqual(["ICN"]);
  });

  it("requires the second leg to depart where the first landed", () => {
    // Without this a route silently invents a ground leg nobody modelled — the
    // same rule that stops round-trip pairing offering open jaws.
    expect(stitch([first("2027-03-10"), find({
      origin: "NRT", destination: "KTM", flight_date: "2027-03-10",
    })]).journeys).toEqual([]);
  });

  it("refuses a hub that is one of the route's own endpoints", () => {
    // SFO->SFO->KTM is not a connection, and neither is a hub the route already
    // lists as a destination.
    const viaOrigin = [
      find({ origin: "SFO", destination: "SFO", flight_date: "2027-03-10" }),
      find({ origin: "SFO", destination: "KTM", flight_date: "2027-03-10" }),
    ];
    expect(stitch(viaOrigin).journeys).toEqual([]);

    const multi = route({ destinations: JSON.stringify(["KTM", "ICN"]) });
    expect(stitch([first("2027-03-10"), second("2027-03-10")], multi).journeys).toEqual([]);
  });

  it("honours a multi-airport route on both sides", () => {
    const r = route({ origins: JSON.stringify(["SFO", "OAK"]) });
    const out = stitch(
      [
        find({ origin: "OAK", destination: "ICN", flight_date: "2027-03-10" }),
        second("2027-03-10"),
      ],
      r,
    );
    expect(chain(out.journeys[0]!)).toBe("OAK>ICN>KTM");
  });

  it("finds every hub that has legs on both sides", () => {
    const out = stitch([
      first("2027-03-10"),
      second("2027-03-10"),
      find({ origin: "SFO", destination: "DOH", flight_date: "2027-03-10" }),
      find({ origin: "DOH", destination: "KTM", flight_date: "2027-03-10" }),
      // A hub with a leg in and none out contributes nothing, and must not
      // appear as though it did.
      find({ origin: "SFO", destination: "SIN", flight_date: "2027-03-10" }),
    ]);
    expect(out.hubs).toEqual(["DOH", "ICN"]);
    expect(out.journeys).toHaveLength(2);
  });
});

describe("stitchJourneys — the connection window", () => {
  it("joins a same-day connection", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.connectDays).toBe(0);
  });

  it("joins an overnight in the hub by default", () => {
    // For ICN, DOH or IST the overnight is routinely the only realistic option.
    expect(DEFAULT_MAX_CONNECT_DAYS).toBe(1);
    const out = stitch([first("2027-03-10"), second("2027-03-11")]);
    expect(out.journeys).toHaveLength(1);
    expect(out.journeys[0]!.connectDays).toBe(1);
  });

  it("does not join two days apart at the default", () => {
    expect(stitch([first("2027-03-10"), second("2027-03-12")]).journeys).toEqual([]);
  });

  it("never joins a second leg that departs before the first", () => {
    expect(stitch([first("2027-03-10"), second("2027-03-09")]).journeys).toEqual([]);
  });

  it("clamps an absurd window instead of looping forever", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-12")], route(), {
      maxConnectDays: 5_000,
    });
    expect(out.journeys).toHaveLength(1);
    expect(MAX_CONNECT_DAYS).toBeLessThan(30);
  });

  it("lets the second leg fall one day past the window's end", () => {
    // An overnight on the last gathered date is a real journey; clipping it
    // would drop the answer at exactly the edge that was asked about.
    const out = stitch([first("2027-03-31"), second("2027-04-01")]);
    expect(out.journeys).toHaveLength(1);
  });

  it("still refuses a first leg outside the window", () => {
    expect(stitch([first("2027-04-05"), second("2027-04-05")]).journeys).toEqual([]);
  });
});

describe("stitchJourneys — cabins and programs", () => {
  it("joins legs in DIFFERENT cabins", () => {
    // The one deliberate difference from round-trip pairing: economy to the hub
    // and business long-haul is the ordinary award shape.
    const out = stitch([first("2027-03-10", { cabin: "economy" }), second("2027-03-10")]);
    expect(out.journeys).toHaveLength(1);
    expect(out.journeys[0]!.legs.map((l) => l.find.cabin)).toEqual(["economy", "business"]);
  });

  it("still applies the route's own cabin filter to both legs", () => {
    // The legs were cleared by whichever OTHER route gathered them, so without
    // this a business-only route could be shown an economy leg it excludes.
    const r = route({ cabins: JSON.stringify(["business"]) });
    expect(stitch([first("2027-03-10", { cabin: "economy" }), second("2027-03-10")], r).journeys)
      .toEqual([]);
    expect(stitch([first("2027-03-10"), second("2027-03-10")], r).journeys).toHaveLength(1);
  });

  it("marks a journey mixed when the programs differ", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10", { program: "aeroplan" })]);
    expect(out.journeys[0]!.mixed).toBe(true);
    expect(out.journeys[0]!.programs).toEqual(["alaska", "aeroplan"]);
  });

  it("is not mixed when one program flies both legs", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.mixed).toBe(false);
    expect(out.journeys[0]!.programs).toEqual(["alaska"]);
  });
});

describe("stitchJourneys — the route's other filters", () => {
  it("drops a leg below the route's seat floor", () => {
    const r = route({ min_seats: 4 });
    expect(stitch([first("2027-03-10", { seats_available: 2 }), second("2027-03-10", { seats_available: 6 })], r)
      .journeys).toEqual([]);
  });

  it("drops a leg over the route's point limit", () => {
    // Borrowed legs never went through ROUTE_FINDS_MATCH under THIS route, so
    // the ceiling has to be re-applied here or a capped route is shown a
    // journey built out of an award it would never display on its own.
    const r = route({ point_limit: 60_000 });
    expect(stitch([first("2027-03-10", { miles_cost: 90_000 }), second("2027-03-10")], r).journeys)
      .toEqual([]);
    expect(stitch([first("2027-03-10"), second("2027-03-10")], r).journeys).toHaveLength(1);
  });

  it("caps on the journey TOTAL, not only on each leg", () => {
    // Both legs are under 60k; the journey they make is not, and the total is
    // what the Cost column prints.
    const r = route({ point_limit: 60_000 });
    expect(stitch([first("2027-03-10", { miles_cost: 40_000 }), second("2027-03-10", { miles_cost: 40_000 })], r)
      .journeys).toEqual([]);
    expect(stitch([first("2027-03-10", { miles_cost: 30_000 }), second("2027-03-10", { miles_cost: 30_000 })], r)
      .journeys).toHaveLength(1);
  });

  it("keeps a leg the route's currency filter allows", () => {
    const r = route({ currencies: JSON.stringify(["bilt"]) });
    const out = stitch(
      [
        first("2027-03-10", { transfer_currencies: JSON.stringify(["bilt"]) }),
        second("2027-03-10", { transfer_currencies: JSON.stringify(["bilt", "chase_ur"]) }),
      ],
      r,
    );
    expect(out.journeys).toHaveLength(1);
  });

  it("drops a leg no allowed currency can book", () => {
    const r = route({ currencies: JSON.stringify(["chase_ur"]) });
    expect(
      stitch(
        [
          first("2027-03-10", { transfer_currencies: JSON.stringify(["bilt"]) }),
          second("2027-03-10", { transfer_currencies: JSON.stringify(["chase_ur"]) }),
        ],
        r,
      ).journeys,
    ).toEqual([]);
  });

  it("counts a known cash fare as bookable, erring wide rather than hiding", () => {
    // The portal half of the SQL's currency clause needs PORTAL_CURRENCIES,
    // which the SPA cannot import. Passing a cash fare outright is the
    // over-inclusive error, which is the safe one here.
    const r = route({ currencies: JSON.stringify(["chase_ur"]) });
    const out = stitch(
      [
        first("2027-03-10", { transfer_currencies: "[]", cash_price_cents: 90_000 }),
        second("2027-03-10", { transfer_currencies: JSON.stringify(["chase_ur"]) }),
      ],
      r,
    );
    expect(out.journeys).toHaveLength(1);
  });

  it("treats no currency filter as no filter", () => {
    const out = stitch([
      first("2027-03-10", { transfer_currencies: "[]" }),
      second("2027-03-10", { transfer_currencies: "[]" }),
    ]);
    expect(out.journeys).toHaveLength(1);
  });
});

describe("stitchJourneys — the derived numbers", () => {
  it("sums the miles and the fees, and says the total is a sum", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.totalMiles).toBe(60_000);
    expect(out.journeys[0]!.totalFeesCents).toBe(1_120);
  });

  it("takes the LOWEST leg's seats — a journey needs seats on every leg", () => {
    const out = stitch([
      first("2027-03-10", { seats_available: 5 }),
      second("2027-03-10", { seats_available: 2 }),
    ]);
    expect(out.journeys[0]!.seats).toBe(2);
  });

  it("reports the ground time as UNKNOWN when the legs carry no times", () => {
    // A summary row has no times at all, and guessing one would invent a
    // connection that may not exist.
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.legs[0]!.gapMinutes).toBeNull();
    expect(out.journeys[0]!.legs[1]!.gapMinutes).toBeNull();
  });

  it("computes the ground time when both legs are enriched", () => {
    // Both timestamps are local to the hub — the same airport — which is the one
    // case where subtracting two of these unoffset local times is sound.
    const out = stitch([
      first("2027-03-10", {
        segments_json: JSON.stringify([
          { from: "SFO", to: "ICN", carrier: "AS", departsAt: "2027-03-10T11:00:00", arrivesAt: "2027-03-11T16:30:00" },
        ]),
      }),
      second("2027-03-11", {
        segments_json: JSON.stringify([
          { from: "ICN", to: "KTM", carrier: "KE", departsAt: "2027-03-11T19:00:00", arrivesAt: "2027-03-11T23:20:00" },
        ]),
      }),
    ]);
    expect(out.journeys[0]!.legs[1]!.gapMinutes).toBe(150);
  });

  it("never reports a gap on the first leg", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.legs[0]!.gapMinutes).toBeNull();
  });
});

describe("stitchJourneys — ordering, bounds and safety", () => {
  it("sorts by total miles, then by the shorter connection", () => {
    // One first leg reaches BOTH onward dates, so the same hub appears twice —
    // which is the case the tie-break exists for.
    const out = stitch([
      first("2027-03-10"),
      second("2027-03-10", { miles_cost: 40_000 }),
      second("2027-03-11", { miles_cost: 25_000 }),
      find({ origin: "SFO", destination: "DOH", flight_date: "2027-03-10", miles_cost: 20_000 }),
      find({ origin: "DOH", destination: "KTM", flight_date: "2027-03-10", miles_cost: 20_000 }),
    ]);
    expect(out.journeys.map((j) => [j.via[0], j.totalMiles, j.connectDays])).toEqual([
      ["DOH", 40_000, 0],
      ["ICN", 60_000, 1],
      ["ICN", 75_000, 0],
    ]);
  });

  it("reports truncation rather than quietly shortening the list", () => {
    // Five distinct hubs, because five onward legs on ONE date collapse to one
    // slot — `collapseLegs` keys on (pair, date, cabin) and keeps the cheapest.
    const finds: Find[] = [];
    for (let i = 0; i < 5; i++) {
      const hub = `H${i}`;
      finds.push(
        find({ origin: "SFO", destination: hub, flight_date: "2027-03-10", miles_cost: 20_000 + i }),
        find({ origin: hub, destination: "KTM", flight_date: "2027-03-10", miles_cost: 20_000 + i }),
      );
    }
    const out = stitch(finds, route(), { limit: 2 });
    expect(out.journeys).toHaveLength(2);
    expect(out.considered).toBe(5);
    expect(out.truncated).toBe(true);
    // The cheapest survive the cap.
    expect(out.journeys.map((j) => j.totalMiles)).toEqual([40_000, 40_002]);
  });

  it("reports which side was empty, so a miss can be explained", () => {
    const noOnward = stitch([first("2027-03-10")]);
    expect(noOnward.outboundSlots).toBe(1);
    expect(noOnward.inboundSlots).toBe(0);
    expect(noOnward.hubs).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    // The easiest bug to ship here is an in-place `.sort()`.
    const finds = [second("2027-03-10"), first("2027-03-10")];
    const before = JSON.stringify(finds);
    stitch(finds);
    expect(JSON.stringify(finds)).toBe(before);
  });

  it("stays slots x span rather than a cross product", () => {
    // Twenty legs each side over a two-day span. Each first leg reaches its own
    // date and the next, so the answer is 20 x 2 minus the last day's missing
    // partner — NOT the 400 a cross product would consider. Same property
    // `roundtrip.test.ts` pins for the nights loop.
    const finds: Find[] = [];
    for (let i = 0; i < 20; i++) {
      const date = `2027-03-${String(i + 1).padStart(2, "0")}`;
      finds.push(first(date), second(date));
    }
    const out = stitch(finds);
    expect(out.considered).toBe(39);
    expect(out.considered).toBeLessThan(20 * 20);
  });

  it("answers an empty find list with an empty, untruncated result", () => {
    expect(stitch([])).toEqual({
      journeys: [],
      considered: 0,
      truncated: false,
      hubs: [],
      outboundSlots: 0,
      inboundSlots: 0,
    });
  });

  it("collapses two sources' answers for one slot into the best leg", () => {
    // `findsCte` collapses across sources at query time and can still hand back
    // two rows for one slot; `collapseLegs` is what stops that becoming two
    // identical journeys.
    const out = stitch([
      first("2027-03-10", { source: "seatsaero", miles_cost: 35_000 }),
      first("2027-03-10", { source: "other", miles_cost: 30_000 }),
      second("2027-03-10"),
    ]);
    expect(out.journeys).toHaveLength(1);
    expect(out.journeys[0]!.totalMiles).toBe(55_000);
  });
});

describe("stitchJourneys — the fee currency", () => {
  it("totals the fees when both legs are charged in the same currency", () => {
    const out = stitch([first("2027-03-10"), second("2027-03-10")]);
    expect(out.journeys[0]!.feesCurrency).toBe("USD");
    expect(out.journeys[0]!.totalFeesCents).toBe(1_120);
  });

  it("reads a missing currency as USD, the column's own default", () => {
    const out = stitch([
      first("2027-03-10", { fees_currency: "USD" }),
      second("2027-03-10"),
    ]);
    expect(out.journeys[0]!.feesCurrency).toBe("USD");
  });

  it("REFUSES to name a currency when the legs disagree", () => {
    // The real case: seats.aero quotes Korean Air out of Seoul in KRW, so a
    // genuine SFO→ICN→KTM adds 560 USD cents to 2,400,000 KRW. The sum is a
    // number with no meaning, and rendered as dollars it reads as $24,029.90
    // for about $1,700 of tax. Null is the instruction not to show a total.
    const out = stitch([
      first("2027-03-10", { cash_fees_cents: 560, fees_currency: "USD" }),
      second("2027-03-10", { cash_fees_cents: 2_400_000, fees_currency: "KRW" }),
    ]);
    expect(out.journeys[0]!.feesCurrency).toBeNull();
  });

  it("still sums the MILES across a mixed-currency journey", () => {
    // Miles are the program's own unit and the legs are priced in it either way;
    // only the cash taxes are incomparable.
    const out = stitch([
      first("2027-03-10", { fees_currency: "USD" }),
      second("2027-03-10", { fees_currency: "KRW" }),
    ]);
    expect(out.journeys[0]!.totalMiles).toBe(60_000);
  });
});
