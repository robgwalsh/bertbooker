import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/seatsaero-trips.json" with { type: "json" };
import {
  buildTripsUrl,
  parseSeatsAeroTrips,
  runSeatsAeroTrips,
  SEATSAERO_REDACTED,
  type SeatsAeroTripExpectation,
  type SeatsAeroTripsResponse,
} from "./seatsaero.js";
import { makeTransport } from "./transport.js";

// The fixture is a REAL, untrimmed `GET /partnerapi/trips/{id}` capture taken
// 2026-08-10 by `npm run probe:seatsaero-trips`. Nothing here is hand-authored,
// which matters more than usual: this parser decides which physical aeroplane a
// stored find describes, and every interesting property below (mixed prices
// under one id, cabins as words, local times wearing a Z) was discovered in the
// payload rather than assumed about it.

const body = fixture.body as SeatsAeroTripsResponse;
const availability = fixture.availability as Record<string, unknown>;
const AVAILABILITY_ID = fixture.availabilityId as string;

/** What the stored snapshot rows say, read off the same capture's summary row —
 *  economy 37,500 and business 150,000. */
const expected: SeatsAeroTripExpectation = {
  availabilityId: AVAILABILITY_ID,
  milesByCabin: { economy: 37_500, business: 150_000 },
};

describe("buildTripsUrl", () => {
  it("addresses the availability id", () => {
    expect(buildTripsUrl("abc123")).toBe("https://seats.aero/partnerapi/trips/abc123");
  });

  it("escapes the id rather than pasting it into the path", () => {
    expect(buildTripsUrl("a/b?c")).toBe("https://seats.aero/partnerapi/trips/a%2Fb%3Fc");
  });
});

describe("parseSeatsAeroTrips — the price filter", () => {
  it("THE point of the filter: one id holds trips at several prices", () => {
    // Without this being true the filter would be ceremony. It is not: this one
    // availability row expands into economy itineraries at three different
    // prices, and the stored find quotes only the cheapest.
    const economyPrices = new Set(
      (body.data ?? []).filter((t) => t.Cabin === "economy").map((t) => Number(t.MileageCost)),
    );
    expect([...economyPrices].sort((a, b) => a - b)).toEqual([37_500, 40_000, 75_000]);
    expect(Number(availability.YMileageCost)).toBe(37_500);
  });

  it("keeps only trips priced like the stored find", () => {
    const { details } = parseSeatsAeroTrips(body, expected);
    for (const d of details) {
      expect(d.milesCost).toBe(expected.milesByCabin[d.cabin]);
    }
  });

  it("would otherwise pick a cheaper-looking trip you cannot actually have", () => {
    // The fastest economy itineraries in the payload cost 40,000 — 2,500 more
    // than the find claims — and are hours quicker than anything at 37,500.
    // Collapse without the price filter and one of those lands on a 37,500-mile
    // row. Proven by asking for the wrong price and watching a different, faster
    // trip win.
    const fastestAt = (miles: number) =>
      Math.min(
        ...(body.data ?? [])
          .filter((t) => t.Cabin === "economy" && Number(t.MileageCost) === miles)
          .map((t) => Number(t.TotalDuration)),
      );

    const wrong = parseSeatsAeroTrips(body, {
      availabilityId: AVAILABILITY_ID,
      milesByCabin: { economy: 40_000 },
    });
    const eco = wrong.details.find((d) => d.cabin === "economy")!;
    expect(eco.milesCost).toBe(40_000);
    expect(eco.durationMinutes).toBe(fastestAt(40_000));
    // The trap: dearer AND quicker, so "best itinerary" alone would prefer it.
    expect(fastestAt(40_000)).toBeLessThan(fastestAt(37_500));

    const right = parseSeatsAeroTrips(body, expected).details.find((d) => d.cabin === "economy")!;
    expect(right.milesCost).toBe(37_500);
    expect(right.segments.map((s) => s.flightNumber)).not.toEqual(
      eco.segments.map((s) => s.flightNumber),
    );
  });

  it("leaves a cabin alone when nothing matches, and says so", () => {
    const { details, notes } = parseSeatsAeroTrips(body, {
      availabilityId: AVAILABILITY_ID,
      milesByCabin: { economy: 12_345 },
    });
    expect(details).toHaveLength(0);
    expect(notes.join(" ")).toContain("no economy trip at the stored price");
  });

  it("ignores cabins we hold no row for", () => {
    // The payload carries business trips; an economy-only expectation must not
    // pick them up.
    const { details } = parseSeatsAeroTrips(body, {
      availabilityId: AVAILABILITY_ID,
      milesByCabin: { economy: 37_500 },
    });
    expect(details.map((d) => d.cabin)).toEqual(["economy"]);
  });
});

describe("parseSeatsAeroTrips — collapse", () => {
  it("returns at most one itinerary per cabin", () => {
    const { details } = parseSeatsAeroTrips(body, expected);
    expect(details.map((d) => d.cabin).sort()).toEqual(["business", "economy"]);
  });

  it("breaks the price tie on duration, via the shared collapse rule", () => {
    // Five economy trips cost exactly 37,500, all with 9 seats and 1 stop, so
    // betterOffer falls through to the shortest — 1566 minutes on AS1327/JL67.
    const tied = (body.data ?? []).filter(
      (t) => t.Cabin === "economy" && Number(t.MileageCost) === 37_500,
    );
    expect(tied.length).toBeGreaterThan(1);

    const eco = parseSeatsAeroTrips(body, expected).details.find((d) => d.cabin === "economy")!;
    expect(eco.durationMinutes).toBe(Math.min(...tied.map((t) => Number(t.TotalDuration))));
    expect(eco.segments.map((s) => s.flightNumber)).toEqual(["AS1327", "JL67"]);
  });
});

describe("parseSeatsAeroTrips — segments", () => {
  const eco = parseSeatsAeroTrips(body, expected).details.find((d) => d.cabin === "economy")!;

  it("produces the real legs a summary row lacks", () => {
    expect(eco.segments).toHaveLength(2);
    expect(eco.stops).toBe(1);
    expect(eco.segments[0]).toMatchObject({
      from: "SFO",
      to: "SEA",
      carrier: "AS",
      flightNumber: "AS1327",
      aircraft: "Boeing 737-900",
      cabin: "economy",
    });
    expect(eco.segments[1]).toMatchObject({ from: "SEA", to: "NRT", carrier: "JL" });
  });

  it("strips the Z, because these are local times wearing one", () => {
    // JL67 is stamped 11:50Z -> 15:05Z the NEXT day, 27h15 apart, beside its own
    // stated Duration of 615 minutes. Wall-clock times at each airport, not UTC.
    const leg = eco.segments[1]!;
    expect(leg.departsAt).toBe("2026-12-09T11:50:00");
    expect(leg.arrivesAt).toBe("2026-12-10T15:05:00");
    expect(leg.departsAt).not.toContain("Z");
  });

  it("orders legs by Order, not by array position", () => {
    const shuffled: SeatsAeroTripsResponse = {
      data: [
        {
          AvailabilityID: AVAILABILITY_ID,
          Cabin: "economy",
          MileageCost: 1000,
          Stops: 1,
          AvailabilitySegments: [
            { Order: 1, FlightNumber: "AS2", OriginAirport: "SEA", DestinationAirport: "NRT" },
            { Order: 0, FlightNumber: "AS1", OriginAirport: "SFO", DestinationAirport: "SEA" },
          ],
        },
      ],
    };
    const { details } = parseSeatsAeroTrips(shuffled, {
      availabilityId: AVAILABILITY_ID,
      milesByCabin: { economy: 1000 },
    });
    expect(details[0]!.segments.map((s) => s.flightNumber)).toEqual(["AS1", "AS2"]);
  });

  it("keeps the flight number carrier-prefixed and derives the carrier from it", () => {
    // One convention for the whole app rather than two; the SPA's
    // flightLabel already strips a duplicated prefix.
    expect(eco.segments[0]!.carrier).toBe("AS");
    expect(eco.segments[0]!.flightNumber).toBe("AS1327");
  });
});

describe("parseSeatsAeroTrips — booking link", () => {
  it("takes the primary link, which is the program that owns the row", () => {
    const { details } = parseSeatsAeroTrips(body, expected);
    for (const d of details) {
      expect(d.bookingUrl).toContain("alaskaair.com");
    }
    // The others are different programs that could also ticket it — not what
    // booking_url means.
    expect(details[0]!.bookingUrl).not.toContain("aa.com");
  });

  it("has no booking url when none is primary", () => {
    const { details } = parseSeatsAeroTrips(
      { ...body, booking_links: [{ label: "x", link: "https://x.test", primary: false }] },
      expected,
    );
    expect(details[0]!.bookingUrl).toBeUndefined();
  });
});

describe("parseSeatsAeroTrips — refusals", () => {
  it("THROWS on a payload for a different availability", () => {
    // The one failure that would silently decorate a find with someone else's
    // flights, and be indistinguishable from success afterwards.
    expect(() =>
      parseSeatsAeroTrips(body, { ...expected, availabilityId: "some-other-id" }),
    ).toThrow(/expected some-other-id/);
  });

  it("drops an unrecognised cabin rather than guessing it", () => {
    const odd: SeatsAeroTripsResponse = {
      data: [
        {
          AvailabilityID: AVAILABILITY_ID,
          Cabin: "sleeper-suite",
          MileageCost: 1000,
          AvailabilitySegments: [{ Order: 0, FlightNumber: "AS1" }],
        },
      ],
    };
    const { details, notes } = parseSeatsAeroTrips(odd, {
      availabilityId: AVAILABILITY_ID,
      milesByCabin: { first: 1000 },
    });
    expect(details).toHaveLength(0);
    expect(notes.join(" ")).toContain("sleeper-suite×1");
  });

  it("survives an empty payload without claiming anything", () => {
    const { details } = parseSeatsAeroTrips({ data: [] }, expected);
    expect(details).toHaveLength(0);
  });
});

// --- the fetching half -----------------------------------------------------

const transportOver = (impl: (url: string) => Promise<Response>) =>
  makeTransport({ base: impl });

function stub(payload: unknown, init: ResponseInit = {}) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  };
  return { impl, urls };
}

describe("runSeatsAeroTrips", () => {
  it("spends exactly one call and reads the allowance off it", async () => {
    const { impl, urls } = stub(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "812",
        "x-ratelimit-limit": "1000",
      },
    });
    const out = await runSeatsAeroTrips(expected, {
      apiKey: "secret",
      transport: transportOver(impl),
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/trips/${AVAILABILITY_ID}`);
    expect(out.details).toHaveLength(2);
    expect(out.quota).toMatchObject({ remaining: 812, limit: 1000 });
  });

  it("never lets the key into the call record", async () => {
    const { impl } = stub(body);
    const out = await runSeatsAeroTrips(expected, {
      apiKey: "super-secret-key",
      transport: transportOver(impl),
    });
    expect(out.call.requestHeaders["Partner-Authorization"]).toBe(SEATSAERO_REDACTED);
    expect(JSON.stringify(out.call)).not.toContain("super-secret-key");
  });

  it("THROWS on an HTTP error instead of returning nothing", async () => {
    // An empty result would read as "seats.aero has no itinerary for this find",
    // and the caller would stamp enriched_at and stop offering to retry.
    const { impl } = stub("upstream exploded", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(
      runSeatsAeroTrips(expected, { apiKey: "k", transport: transportOver(impl) }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("THROWS when the key is refused", async () => {
    const { impl } = stub("nope", { status: 401, headers: { "content-type": "application/json" } });
    await expect(
      runSeatsAeroTrips(expected, { apiKey: "k", transport: transportOver(impl) }),
    ).rejects.toThrow();
  });

  it("carries the call record onto the thrown error", async () => {
    // The enrich endpoint reports the failure to the person who clicked, and the
    // status is the whole diagnosis: 401 is a wrong key, 429 is a spent day.
    const { impl } = stub("no", { status: 500, headers: { "content-type": "application/json" } });
    const err = await runSeatsAeroTrips(expected, {
      apiKey: "k",
      transport: transportOver(impl),
    }).catch((e) => e);
    expect(err.call.status).toBe(500);
    expect(err.call.ok).toBe(false);
  });
});
