import { describe, expect, it } from "vitest";
import capture from "./__fixtures__/seatsaero-search-trips.json" with { type: "json" };
import {
  buildSearchUrl,
  normalizeSeatsAero,
  seatsAeroTake,
  SEATSAERO_TAKE,
  SEATSAERO_TAKE_WITH_TRIPS,
  type SeatsAeroSearchResponse,
} from "./seatsaero.js";

/**
 * `GET /search?include_trips=true` — the itinerary riding along on the search.
 *
 * A REAL capture (`npm run probe:seatsaero-search`, 2026-08-10, SFO->NRT), not a
 * hand-authored shape, because this payload settled several things the docs do
 * not say — see docs/SEATS-AERO.md. The one that matters most:
 * **there is no `AvailabilitySegments` array here.** The routing is spread across
 * `OriginAirport` + `Connections` + `DestinationAirport` with parallel
 * `FlightNumbers` / `Aircraft` / `FareClasses` lists, so the legs have to be
 * rebuilt rather than read.
 *
 * The fixture is trimmed to 3 rows × 3 trips, which is why the assertions below
 * quote small numbers. Everything they assert is a property of the real payload.
 */
const resp = (capture as { body: unknown }).body as SeatsAeroSearchResponse;
const norm = normalizeSeatsAero(resp, "api:seatsaero", 999);

const alaska = (cabin: string) =>
  norm.offers.find((o) => o.program === "alaska" && o.cabin === cabin);

describe("buildSearchUrl — include_trips", () => {
  it("asks for trips and never for minify_trips", () => {
    // minify_trips halves the bytes by dropping Connections, FlightNumbers,
    // Aircraft and FareClasses — every field the routing is made of. It leaves a
    // payload that says a connection exists without saying where.
    const q = new URL(
      buildSearchUrl({
        origin: "SFO",
        destination: "NRT",
        startDate: "2026-12-08",
        endDate: "2026-12-11",
        includeTrips: true,
      }),
    ).searchParams;
    expect(q.get("include_trips")).toBe("true");
    expect(q.get("minify_trips")).toBeNull();
  });

  it("never sends a gather-time filter", () => {
    // Gather wide, query narrow. `only_direct_flights` and `cabins` are
    // documented and real; anything they drop is missing from the database for
    // every future question, including ones nobody has asked yet.
    const q = new URL(
      buildSearchUrl({
        origin: "SFO",
        destination: "NRT",
        startDate: "2026-12-08",
        endDate: "2026-12-11",
        includeTrips: true,
      }),
    ).searchParams;
    for (const p of ["only_direct_flights", "cabins", "cabin", "carriers", "order_by"]) {
      expect(q.get(p)).toBeNull();
    }
  });

  it("joins several airports per side with commas", () => {
    const q = new URL(
      buildSearchUrl({
        origin: ["sfo", " oak ", "SJC"],
        destination: ["NRT", "HND"],
        startDate: "2026-12-08",
        endDate: "2026-12-11",
      }),
    ).searchParams;
    expect(q.get("origin_airport")).toBe("SFO,OAK,SJC");
    expect(q.get("destination_airport")).toBe("NRT,HND");
  });

  it("takes a smaller page when trips ride along", () => {
    // Measured: a summary row is ~2.2KB, the same row with trips ~9.9KB. At
    // take=1000 that is a 10MB response for the Worker to hold twice over.
    expect(seatsAeroTake(true)).toBe(SEATSAERO_TAKE_WITH_TRIPS);
    expect(seatsAeroTake(false)).toBe(SEATSAERO_TAKE);
    expect(SEATSAERO_TAKE_WITH_TRIPS).toBeLessThan(SEATSAERO_TAKE);
  });
});

describe("normalizeSeatsAero — trips embedded in the search", () => {
  it("rebuilds the real legs from the airport chain", () => {
    const y = alaska("economy")!;
    expect(y.detailLevel).toBe("itinerary");
    expect(y.stops).toBe(1);
    expect(y.segments.map((s) => `${s.from}-${s.to}`)).toEqual(["SFO-SEA", "SEA-NRT"]);
    expect(y.segments.map((s) => s.flightNumber)).toEqual(["AS515", "JL67"]);
  });

  it("KEEPS the trip priced like the stored row, not the quickest one", () => {
    // The whole reason the price filter is shared with /trips rather than
    // reimplemented. This row quotes 37,500 in economy and its trips run
    // 40,000 / 40,000 / 37,500 — and the 37,500 one is the SLOWEST of the three
    // at 2080 minutes against 850. Collapsing on speed would write an 850-minute
    // routing onto a find advertising 37,500, describing an aeroplane you cannot
    // have at that price.
    const y = alaska("economy")!;
    expect(y.milesCost).toBe(37500);
    expect(y.durationMinutes).toBe(2080);
    expect(y.segments.map((s) => s.flightNumber)).toEqual(["AS515", "JL67"]);
  });

  it("leaves a cabin with no matching trip as a summary", () => {
    // Business is available at 150,000 and every trip in the payload is economy.
    // A miss stays a miss — never decorate it with another cabin's itinerary.
    const j = alaska("business")!;
    expect(j.milesCost).toBe(150000);
    expect(j.detailLevel).toBe("summary");
    expect(j.segments).toHaveLength(1);
    expect(j.segments[0]!.flightNumber).toBeUndefined();
    // And it must NOT claim a stop count it was never told.
    expect(j.stops).toBeUndefined();
  });

  it("reads each leg's carrier off its flight number, not off Carriers", () => {
    // `Carriers` is the DISTINCT set: two Alaska legs give "AS", not "AS, AS".
    // Indexing it by leg misaligns every leg after the first on a mixed trip.
    const aa = norm.offers.find((o) => o.program === "aadvantage" && o.cabin === "economy")!;
    expect(aa.milesCost).toBe(45000);
    expect(aa.segments.map((s) => s.flightNumber)).toEqual(["AA2614", "JL55"]);
    expect(aa.segments.map((s) => s.carrier)).toEqual(["AA", "JL"]);
  });

  it("attaches aircraft and fare class per leg, and tolerates their absence", () => {
    // Both are genuinely optional and absent on different programs in the SAME
    // response: `azul` sends no Aircraft, `american` sends no FareClasses.
    const y = alaska("economy")!;
    expect(y.segments.map((s) => s.aircraft)).toEqual(["Boeing 737-900", "Boeing 787-9"]);
    expect(y.segments.map((s) => s.fareClass)).toEqual(["T", "T"]);

    const aa = norm.offers.find((o) => o.program === "aadvantage" && o.cabin === "economy")!;
    expect(aa.segments.map((s) => s.aircraft)).toEqual(["Boeing 737-800", "Boeing 777-300"]);
    expect(aa.segments.every((s) => s.fareClass === undefined)).toBe(true);
  });

  it("puts the trip's times on its endpoints and invents nothing in between", () => {
    // A search-embedded trip has only trip-level DepartsAt/ArrivesAt: the first
    // leg's departure and the last leg's arrival. The connection time at SEA is
    // genuinely unknown, and deriving it from TotalDuration would render a
    // layover nobody measured.
    const legs = alaska("economy")!.segments;
    expect(legs[0]!.departsAt).toBe("2026-12-08T11:25:00");
    expect(legs[0]!.arrivesAt).toBeUndefined();
    expect(legs[1]!.departsAt).toBeUndefined();
    expect(legs[1]!.arrivesAt).toBe("2026-12-10T15:05:00");
  });

  it("strips the Z seats.aero puts on a local time", () => {
    // `AS515` departs 11:25 and `JL67` lands 15:05 two days later — 51 hours
    // apart against a stated TotalDuration of 2080 minutes (34h40). These are
    // wall-clock times at each airport; keeping the suffix would assert UTC.
    for (const s of alaska("economy")!.segments) {
      expect(s.departsAt ?? "").not.toMatch(/Z$/);
      expect(s.arrivesAt ?? "").not.toMatch(/Z$/);
    }
  });

  it("refuses to zip a chain and a flight list that disagree", () => {
    // The real payload always agrees — FlightNumbers is Stops+1 and Connections
    // is Stops on 9 of 9 trips inspected — which is exactly why this needs a
    // synthetic case. Two airports and three flights cannot both be true, and
    // zipping the short list against the long one would name an aeroplane that
    // is not on the ticket. Falling back to the summary is the honest answer;
    // nothing downstream could detect an invented leg.
    const bent: SeatsAeroSearchResponse = {
      data: [
        {
          ID: "x",
          Date: "2026-12-08",
          Source: "alaska",
          Route: { OriginAirport: "SFO", DestinationAirport: "NRT", Source: "alaska" },
          YAvailable: true,
          YMileageCost: "37500",
          YRemainingSeats: 2,
          YTotalTaxes: 560,
          AvailabilityTrips: [
            {
              AvailabilityID: "x",
              Cabin: "economy",
              MileageCost: 37500,
              Stops: 1,
              OriginAirport: "SFO",
              DestinationAirport: "NRT",
              Connections: ["SEA"],
              // Three flights across a two-hop chain.
              FlightNumbers: "AS515, JL67, JL99",
            },
          ],
        },
      ],
    };
    const out = normalizeSeatsAero(bent, "api:seatsaero", 999).offers;
    expect(out).toHaveLength(1);
    expect(out[0]!.detailLevel).toBe("summary");
    expect(out[0]!.segments).toHaveLength(1);
    expect(out[0]!.segments[0]!.flightNumber).toBeUndefined();
  });

  it("still drops an unmapped Source and counts it", () => {
    // `azul` carries trips like everything else; being described is not being
    // storable — availability_snapshots.program is a foreign key.
    expect(norm.offers.some((o) => o.program === "azul")).toBe(false);
    expect(norm.droppedSources.azul).toBe(1);
  });
});
