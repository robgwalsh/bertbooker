import { describe, expect, it } from "vitest";
import alaska from "./__fixtures__/seatsaero-routes.json" with { type: "json" };
import aeroplan from "./__fixtures__/seatsaero-routes-aeroplan.json" with { type: "json" };
import {
  SEATSAERO_REDACTED,
  SEATSAERO_SOURCE_CATALOGUE,
  SEATSAERO_UNMAPPED_SOURCES,
  SEATSAERO_ZERO_ROUTE_NAMES,
  buildRoutesUrl,
  parseSeatsAeroRoutes,
  runSeatsAeroRoutes,
} from "./seatsaero.js";
import type { FetchLike } from "./transport.js";

// The fixtures are REAL `GET /partnerapi/routes?source=X` captures taken
// 2026-08-18 by `npm run probe:seatsaero-search -- --routes …`. Their bodies are
// TRIMMED (25 and 10 rows), which is why each carries a `measured` block
// describing the whole payload — every claim below about the full 8,130 /
// 8,338 rows comes from that block rather than from an assumption.

const measuredAlaska = alaska.measured!;
const measuredAeroplan = aeroplan.measured!;

describe("the captured payload", () => {
  it("is a bare array at the top level, not a {data} envelope", () => {
    expect(Array.isArray(alaska.body)).toBe(true);
    expect(alaska.status).toBe(200);
  });

  it("carries no NumDaysOut on any row of either source", () => {
    // The published example at developers.seats.aero/reference/get-routes-1
    // shows `NumDaysOut: 60`, and `aeroplan` is the very source that example is
    // written from — yet zero of its 8,338 rows carry the field. Pinned because
    // a per-route monitoring horizon is the obvious thing to want from this
    // endpoint, and the honest answer is that the data does not exist.
    expect(measuredAlaska.keys).not.toHaveProperty("NumDaysOut");
    expect(measuredAeroplan.keys).not.toHaveProperty("NumDaysOut");
    expect(measuredAeroplan.numDaysOutValues).toEqual([]);
  });

  it("has every pair exactly once within a source", () => {
    // What lets `seatsaero_routes` use (source, origin, destination) as a strict
    // PRIMARY KEY with a plain INSERT.
    expect(measuredAlaska.distinctPairs).toBe(measuredAlaska.rows);
    expect(measuredAeroplan.distinctPairs).toBe(measuredAeroplan.rows);
  });

  it("has integer distances only", () => {
    // What lets `distance_mi` be INTEGER rather than REAL.
    expect(measuredAlaska.fractionalDistance).toBe(0);
    expect(measuredAeroplan.fractionalDistance).toBe(0);
  });

  it("names one source per response, matching the request", () => {
    expect(measuredAlaska.sources).toEqual(["alaska"]);
    expect(measuredAeroplan.sources).toEqual(["aeroplan"]);
  });
});

describe("parseSeatsAeroRoutes", () => {
  it("reads the fields off a real row", () => {
    const { routes } = parseSeatsAeroRoutes(alaska.body, "alaska");
    const first = routes[0]!;
    expect(first).toEqual({
      source: "alaska",
      origin: "DCA",
      destination: "MKE",
      originRegion: "North America",
      destinationRegion: "North America",
      distanceMi: 633,
      routeId: "2WyeLkAtRfO62gksnhF5d1G2JJm",
    });
  });

  it("ignores the probe's own trim sentinel", () => {
    // `trimDeep` replaces the tail of a trimmed array with the literal STRING
    // "<trimmed N more>". A parser that assumed every element is an object
    // would throw on its own test data — so this is pinned rather than merely
    // handled. The fixture really does end with one.
    const body = alaska.body as unknown[];
    expect(typeof body[body.length - 1]).toBe("string");
    const { routes, malformed } = parseSeatsAeroRoutes(body, "alaska");
    expect(routes).toHaveLength(body.length - 1);
    expect(malformed).toBe(0);
  });

  it("accepts a {data} envelope too", () => {
    // Every other endpoint on this API wraps. Being wrong about which shape
    // arrives would look exactly like a program that flies nowhere.
    const { routes } = parseSeatsAeroRoutes({ data: alaska.body }, "alaska");
    expect(routes.length).toBeGreaterThan(0);
  });

  it("parses an empty array to zero routes WITHOUT throwing", () => {
    // The single most important case. seats.aero answers `200 []` for a source
    // name it does not recognise, and that is an ANSWER — the caller records it
    // as `empty`. Turning it into a throw here would make a real verdict
    // indistinguishable from a network failure.
    expect(() => parseSeatsAeroRoutes([], "britishairways")).not.toThrow();
    const parsed = parseSeatsAeroRoutes([], "britishairways");
    expect(parsed).toEqual({ routes: [], malformed: 0, duplicates: 0 });
  });

  it("drops rows missing an endpoint, and counts them", () => {
    const parsed = parseSeatsAeroRoutes(
      [
        { OriginAirport: "SFO", DestinationAirport: "NRT", Source: "alaska" },
        { OriginAirport: "SFO", Source: "alaska" },
        { DestinationAirport: "HND", Source: "alaska" },
      ],
      "alaska",
    );
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.malformed).toBe(2);
  });

  it("drops a duplicate pair, keeping the first, and counts it", () => {
    // `seatsaero_routes` has (source, origin, destination) as its PRIMARY KEY,
    // and ONE duplicate would abort the whole transaction — wasting a metered
    // call. The measured payloads have none; this is the belt.
    const parsed = parseSeatsAeroRoutes(
      [
        { OriginAirport: "SFO", DestinationAirport: "NRT", Distance: 5130 },
        { OriginAirport: "SFO", DestinationAirport: "NRT", Distance: 9999 },
      ],
      "alaska",
    );
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0]!.distanceMi).toBe(5130);
    expect(parsed.duplicates).toBe(1);
  });

  it("takes the source off the payload, not off the request", () => {
    // The same rule the rest of this provider follows: endpoints and sources
    // are read off the answer, never assumed from the question.
    const { routes } = parseSeatsAeroRoutes(
      [{ OriginAirport: "SFO", DestinationAirport: "NRT", Source: "aeroplan" }],
      "alaska",
    );
    expect(routes[0]!.source).toBe("aeroplan");
  });

  it("coerces a stringified Distance", () => {
    // `[C]MileageCost` already ships as a string on one endpoint and a number
    // on another, so the number fields here are coerced rather than cast.
    const { routes } = parseSeatsAeroRoutes(
      [{ OriginAirport: "SFO", DestinationAirport: "NRT", Distance: "5130" }],
      "alaska",
    );
    expect(routes[0]!.distanceMi).toBe(5130);
  });
});

describe("runSeatsAeroRoutes", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}): FetchLike =>
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });

  it("asks the documented URL", () => {
    expect(buildRoutesUrl("alaska")).toBe("https://seats.aero/partnerapi/routes?source=alaska");
  });

  it("reads the allowance off the response headers", async () => {
    const out = await runSeatsAeroRoutes("alaska", {
      apiKey: "k",
      transport: ok(alaska.body, { "x-ratelimit-remaining": "977", "x-ratelimit-limit": "1000" }),
    });
    expect(out.quota?.remaining).toBe(977);
    expect(out.quota?.limit).toBe(1000);
    expect(out.httpStatus).toBe(200);
  });

  it("reports zero routes for an empty answer rather than throwing", async () => {
    const out = await runSeatsAeroRoutes("britishairways", { apiKey: "k", transport: ok([]) });
    expect(out.routes).toEqual([]);
    expect(out.httpStatus).toBe(200);
  });

  it("THROWS on a non-2xx instead of returning empty", async () => {
    // Throwing is the failure protocol. An empty result from a refused call is
    // indistinguishable from the `200 []` that means "this source name is not
    // real", and writing that verdict onto a network blip is the one wrong
    // answer this whole surface exists to prevent.
    const transport: FetchLike = async () => new Response("nope", { status: 500 });
    await expect(runSeatsAeroRoutes("alaska", { apiKey: "k", transport })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("never puts the key in a capture", () => {
    expect(alaska.request.headers["Partner-Authorization"]).toBe(SEATSAERO_REDACTED);
    expect(aeroplan.request.headers["Partner-Authorization"]).toBe(SEATSAERO_REDACTED);
  });
});

describe("the source catalogue", () => {
  it("keeps the mapped and unmapped sets disjoint", () => {
    for (const s of SEATSAERO_UNMAPPED_SOURCES) {
      expect(SEATSAERO_ZERO_ROUTE_NAMES).not.toContain(s);
    }
  });

  it("offers every mapped source plus the eight real unmapped ones", () => {
    expect(SEATSAERO_SOURCE_CATALOGUE).toContain("alaska");
    expect(SEATSAERO_SOURCE_CATALOGUE).toContain("smiles");
    expect(SEATSAERO_UNMAPPED_SOURCES).toHaveLength(8);
  });

  it("lists copa as unmapped and connectmiles as a zero-route name", () => {
    // The exact trap `britishairways` fell into: a program's NAME is not its
    // source key. Copa's source is `copa`; `connectmiles` returns nothing.
    expect(SEATSAERO_UNMAPPED_SOURCES).toContain("copa");
    expect(SEATSAERO_ZERO_ROUTE_NAMES).toContain("connectmiles");
  });
});
