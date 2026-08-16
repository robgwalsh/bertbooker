import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/pointsyeah-explorer.json" with { type: "json" };
import { normalizePointsYeah, parseDetail, type PointsYeahResponse } from "./pointsyeah.js";
// Extracted for reuse by the airline sources; their tests live alongside them
// in window.test.ts / filter.test.ts.
import { filterForParams } from "./filter.js";
import type { SearchParams } from "../types.js";

const resp = fixture as PointsYeahResponse;
const norm = normalizePointsYeah(resp, "freetool:pointsyeah", 0);

describe("normalizePointsYeah", () => {
  it("drops unmapped programs (e.g. DL) and keeps mapped ones", () => {
    // Fixture has 6 routes: DL (unmapped, dropped) + B6, AC, AS, AV, AA.
    expect(norm.map((r) => r.program).sort()).toEqual(
      ["aadvantage", "aeroplan", "alaska", "jetblue", "lifemiles"].sort(),
    );
  });

  it("maps program, cabin, miles, seats, and directness", () => {
    const ac = norm.find((r) => r.program === "aeroplan")!;
    expect(ac.origin).toBe("JFK");
    expect(ac.destination).toBe("CPH");
    expect(ac.cabin).toBe("business");
    expect(ac.milesCost).toBe(75000);
    expect(ac.cashFeesCents).toBe(10270); // 102.70 USD
    expect(ac.seatsAvailable).toBe(9);
    expect(ac.isDirect).toBe(false); // 1 stop
  });

  it("derives bookableWith from transfer[], excluding Amex/WF", () => {
    const ac = norm.find((r) => r.program === "aeroplan")!;
    expect(ac.bookableWith!.sort()).toEqual(["bilt", "capital_one", "chase_ur"]);
    const av = norm.find((r) => r.program === "lifemiles")!;
    expect(av.bookableWith!.sort()).toEqual(["bilt", "capital_one", "citi_ty"]); // Amex & WF dropped
    const as = norm.find((r) => r.program === "alaska")!;
    expect(as.bookableWith).toEqual(["bilt"]);
  });
});

describe("filterForParams", () => {
  const base: SearchParams = {
    origin: "JFK",
    destination: "CPH",
    dateStart: "2026-08-01",
    dateEnd: "2026-08-31",
    cabins: ["business"],
    minSeats: 2,
    kind: "flight",
  };

  it("keeps only the matching route within the window/cabin/seats", () => {
    const got = filterForParams(norm, base);
    expect(got).toHaveLength(1);
    expect(got[0]!.program).toBe("aeroplan");
  });

  it("excludes results below the seat threshold", () => {
    // AS (JFK->CAI) has 1 seat; even on its own route minSeats=2 drops it.
    const cai = filterForParams(norm, { ...base, destination: "CAI", minSeats: 2 });
    expect(cai).toHaveLength(0);
    const cai1 = filterForParams(norm, { ...base, destination: "CAI", minSeats: 1 });
    expect(cai1.map((r) => r.program)).toEqual(["alaska"]);
  });

  it("keeps a result when its bookableWith intersects the currency filter", () => {
    // aeroplan (the base match) is bookable with bilt/capital_one/chase_ur.
    const got = filterForParams(norm, { ...base, currencies: ["chase_ur"] });
    expect(got.map((r) => r.program)).toEqual(["aeroplan"]);
  });

  it("drops a result whose currencies don't intersect the filter", () => {
    const got = filterForParams(norm, { ...base, currencies: ["citi_ty"] });
    expect(got).toHaveLength(0);
  });

  it("treats an empty currency filter as no filter", () => {
    const got = filterForParams(norm, { ...base, currencies: [] });
    expect(got.map((r) => r.program)).toEqual(["aeroplan"]);
  });

  it("keeps a result when its cabin is in a multi-cabin filter", () => {
    const got = filterForParams(norm, { ...base, cabins: ["business", "first"] });
    expect(got.map((r) => r.program)).toEqual(["aeroplan"]);
  });

  it("drops a result whose cabin isn't in the cabin filter", () => {
    const got = filterForParams(norm, { ...base, cabins: ["first"] });
    expect(got).toHaveLength(0);
  });

  it("treats an empty cabin filter as any cabin", () => {
    const got = filterForParams(norm, { ...base, cabins: [] });
    expect(got.map((r) => r.program)).toEqual(["aeroplan"]);
  });
});

describe("normalizePointsYeah (search shape)", () => {
  it("reads results[] as well as data.routes[]", () => {
    const routes = resp.data?.routes ?? [];
    const fromResults = normalizePointsYeah({ total: routes.length, results: routes }, "s", 0);
    const fromData = normalizePointsYeah({ data: { routes } }, "s", 0);
    expect(fromResults).toEqual(fromData);
    expect(fromResults.length).toBeGreaterThan(0); // mapped programs survive
  });
});

describe("parseDetail", () => {
  const detail = {
    routes: [
      {
        url: "https://www.aa.com/booking/search?searchType=Award",
        duration: 1029,
        segments: [
          {
            departure_info: { date_time: "2026-08-06T11:21:00", airport: { airport_code: "PIT" } },
            arrival_info: { date_time: "2026-08-06T12:14:00", airport: { airport_code: "ORD" } },
            cabin: "First",
            flight: { airline_code: "AA", number: "AA4457" },
            aircraft: "Embraer 175",
          },
          {
            departure_info: { date_time: "2026-08-06T14:30:00", airport: { airport_code: "ORD" } },
            arrival_info: { date_time: "2026-08-07T17:30:00", airport: { airport_code: "HND" } },
            cabin: "First",
            flight: { airline_code: "JL", number: "JL9" },
            aircraft: "Boeing 777-300 Passenger",
          },
        ],
      },
      { url: "https://ignored.example", segments: [] }, // only the first route is used
    ],
  };

  it("pulls segments, booking url, duration, and derives stops from the first route", () => {
    const d = parseDetail(detail);
    expect(d.bookingUrl).toBe("https://www.aa.com/booking/search?searchType=Award");
    expect(d.durationMinutes).toBe(1029);
    expect(d.stops).toBe(1); // 2 segments → 1 stop
    expect(d.segments).toHaveLength(2);
    expect(d.segments[0]).toMatchObject({
      from: "PIT",
      to: "ORD",
      carrier: "AA",
      flightNumber: "AA4457",
      aircraft: "Embraer 175",
      departsAt: "2026-08-06T11:21:00",
      cabin: "first",
    });
    expect(d.segments[1]!.flightNumber).toBe("JL9");
  });

  it("returns an empty breakdown when there are no routes", () => {
    expect(parseDetail({})).toEqual({ segments: [] });
    expect(parseDetail({ routes: [] })).toEqual({ segments: [] });
  });
});

