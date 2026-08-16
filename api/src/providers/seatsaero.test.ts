import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/seatsaero-search.json" with { type: "json" };
import {
  buildSearchUrl,
  normalizeSeatsAero,
  parseQuotaHeaders,
  planSeatsAeroChunks,
  runSeatsAeroChunk,
  callMetadata,
  datesIn,
  seatsAeroHeaders,
  seatsAeroTaskKey,
  SEATSAERO_MAX_PAGES,
  SEATSAERO_REDACTED,
  type SeatsAeroCall,
  SEATSAERO_PROGRAM_MAP,
  SEATSAERO_PROGRAMS,
  SEATSAERO_SOURCE_ID,
  type SeatsAeroSearchResponse,
} from "./seatsaero.js";
import { makeTransport } from "./transport.js";
import { PROGRAM_SEEDS, currenciesForProgram } from "../domain/programs.js";

// The fixture is hand-authored from the documented Cached Search shape and the
// cases that matter (cabin fan-out, an unreported seat count, an unmapped
// program, a co-terminal route, a zero-mileage cabin). Replace it with a real
// redacted capture when one is taken — the response envelope is stable, but the
// exact per-cabin field names are the one thing worth confirming against the
// wire.

const resp = fixture as SeatsAeroSearchResponse;
const norm = normalizeSeatsAero(resp, "seatsaero", 999);

describe("SEATSAERO_PROGRAM_MAP", () => {
  it("only maps to programs that exist in PROGRAM_SEEDS", () => {
    // availability_snapshots.program is a FK — an unseeded code fails the insert
    // rather than merely being uninteresting.
    const seeded = new Set(PROGRAM_SEEDS.map((s) => s.code));
    for (const code of SEATSAERO_PROGRAMS) expect(seeded.has(code)).toBe(true);
  });

  it("folds the Avios family onto one program code", () => {
    for (const s of ["qatar", "british", "iberia"]) {
      expect(SEATSAERO_PROGRAM_MAP[s]).toBe("avios");
    }
  });

  it("uses only source names verified live against /routes on 2026-08-09", () => {
    // Pinned because the API SILENTLY IGNORES an unknown `sources` value — it
    // answers 200 with an empty array rather than erroring, so a typo here is
    // not a failure anyone would notice, it is a program that contributes
    // nothing forever. `britishairways`, `ana`, `cathay` and `eva` all looked
    // right and all returned zero routes.
    expect(Object.keys(SEATSAERO_PROGRAM_MAP).sort()).toEqual(
      [
        "aeromexico", "aeroplan", "alaska", "american", "british", "delta",
        "emirates", "etihad", "flyingblue", "iberia", "jetblue", "lifemiles",
        "qantas", "qatar", "singapore", "turkish", "united", "virginatlantic",
      ].sort(),
    );
  });

  it("routes aeromexico to a program only Capital One and Citi can reach", () => {
    // Added 2026-08-09. It is the one seats.aero source outside our original
    // set that the couple can actually book — Chase and Bilt do NOT transfer to
    // Aeroméxico Rewards, so a four-currency `bookableWith` here would be a
    // silent lie that makes unreachable seats look reachable.
    expect(SEATSAERO_PROGRAM_MAP.aeromexico).toBe("aeromexico");
    expect(currenciesForProgram("aeromexico").sort()).toEqual(["capital_one", "citi_ty"]);
  });

  it("does not claim programs seats.aero has no source for", () => {
    // These remain valid PROGRAM_SEEDS; they just aren't reachable from here.
    for (const code of ["ana", "cathay", "eva"]) {
      expect(SEATSAERO_PROGRAMS).not.toContain(code);
    }
  });
});

describe("buildSearchUrl", () => {
  it("builds a Cached Search query and leaves order_by at its default", () => {
    const url = buildSearchUrl({
      origin: "SFO",
      destination: "NRT",
      startDate: "2027-03-01",
      endDate: "2027-05-29",
    });
    expect(url.startsWith("https://seats.aero/partnerapi/search?")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("origin_airport")).toBe("SFO");
    expect(q.get("destination_airport")).toBe("NRT");
    expect(q.get("start_date")).toBe("2027-03-01");
    expect(q.get("end_date")).toBe("2027-05-29");
    expect(q.get("take")).toBe("1000");
    expect(q.get("cursor")).toBeNull();
    // Departure-date ordering is what makes truncation narrowing sound.
    expect(q.get("order_by")).toBeNull();
    // We ask only for programs we can store.
    expect(q.get("sources")!.split(",")).toContain("aeroplan");
  });

  it("carries a cursor when paginating", () => {
    const url = buildSearchUrl({
      origin: "SFO",
      destination: "NRT",
      startDate: "2027-03-01",
      endDate: "2027-03-10",
      cursor: 4211,
    });
    expect(new URL(url).searchParams.get("cursor")).toBe("4211");
  });
});

describe("normalizeSeatsAero", () => {
  it("fans one availability object out to one result per cabin with space", () => {
    const alaska = norm.offers.filter((o) => o.program === "alaska");
    expect(alaska.map((o) => o.cabin).sort()).toEqual(["business", "economy"]);

    const y = alaska.find((o) => o.cabin === "economy")!;
    expect(y.milesCost).toBe(37500);
    expect(y.seatsAvailable).toBe(9);
    expect(y.cashFeesCents).toBe(2560); // $25.60 — TotalTaxes is in cents
    expect(y.feesCurrency).toBe("USD");
    expect(y.isDirect).toBe(true);
    expect(y.stops).toBe(0);
    // The carrier on a NONSTOP row comes from `YDirectAirlines`, not from the
    // head of `YAirlines`. This row reads `YAirlines: "AS, CX, JL, JX, PR"`
    // beside `YDirectAirlines: "JL"` — five carriers serve the market in
    // economy and exactly one of them flies it nonstop. Taking `airlines[0]`
    // labelled this "AS", which is specifically not the nonstop operator.
    expect(y.segments).toEqual([{ from: "SFO", to: "NRT", carrier: "JL", cabin: "economy" }]);
    expect(y.airlines).toEqual(["AS", "CX", "JL", "JX", "PR"]);
    expect(y.directAirlines).toEqual(["JL"]);

    const j = alaska.find((o) => o.cabin === "business")!;
    expect(j.milesCost).toBe(130000);
    expect(j.cashFeesCents).toBe(4120);
    expect(j.isDirect).toBe(false);
    expect(j.stops).toBeUndefined();
  });

  it("parses MileageCost even though the wire sends it as a STRING", () => {
    // Real payload: "YMileageCost": "37500". Every other numeric field on the
    // object is a number; this one is not, and a bare `>` comparison against a
    // string would have quietly mis-sorted rather than failed.
    const raw = (resp.data ?? [])[0]!;
    expect(typeof raw.YMileageCost).toBe("string");
    expect(norm.offers.find((o) => o.program === "alaska")!.milesCost).toBe(37500);
  });

  it("reads the filtered fields, not their *Raw twins", () => {
    // The alaska row carries WAvailableRaw:true / WMileageCostRaw:170000 while
    // WAvailable is false — the Raw variants include dynamically-priced results
    // seats.aero itself filters out. Reading them would invent a premium-cabin
    // find that isn't bookable.
    const raw = (resp.data ?? [])[0]!;
    expect(raw.WAvailableRaw).toBe(true);
    expect(raw.WAvailable).toBe(false);
    expect(norm.offers.some((o) => o.program === "alaska" && o.cabin === "premium")).toBe(false);
  });

  it("does not confuse YDirect with the YDirect* family of fields", () => {
    // `YDirectMileageCost`, `YDirectAirlines`, `YDirectRemainingSeats` all share
    // the `YDirect` prefix. Only the exact key `YDirect` is the boolean.
    const raw = (resp.data ?? [])[0]!;
    expect(raw.YDirect).toBe(true);
    expect(raw.JDirect).toBe(false);
    expect(norm.offers.find((o) => o.program === "alaska" && o.cabin === "business")!.isDirect).toBe(
      false,
    );
  });

  it("drops an unmapped Source and counts it instead of going quiet", () => {
    // `smiles` is a real seats.aero source we deliberately don't map.
    expect(norm.offers.some((o) => o.program === "smiles")).toBe(false);
    expect(norm.droppedSources).toEqual({ smiles: 1 });
  });

  it("treats RemainingSeats 0 as unknown, not as no seats", () => {
    // American reports no seat counts at all. `YAvailable: true` already said
    // there is space, so storing the literal 0 would hide the row from every
    // minSeats filter. Confirmed live: 21 of 200 rows in one page look like this.
    const aa = norm.offers.find((o) => o.program === "aadvantage")!;
    expect((resp.data ?? [])[1]!.YRemainingSeats).toBe(0);
    expect(aa.seatsAvailable).toBe(1);
  });

  it("drops a cabin flagged available but priced at zero miles", () => {
    // Defensive: not present in the captured page, so asserted against a
    // synthetic row. Available-with-zero-miles is not a free seat, it is a
    // payload we cannot price.
    const odd = normalizeSeatsAero(
      {
        data: [
          {
            Route: { OriginAirport: "SFO", DestinationAirport: "NRT" },
            Date: "2027-03-01",
            Source: "united",
            JAvailable: true,
            JMileageCost: "0",
          },
        ],
      },
      "seatsaero",
      1,
    );
    expect(odd.offers).toEqual([]);
  });

  it("reads the route off the payload, not off the request", () => {
    // Co-terminal answers are real (Delta returns SFO->HND for an SFO->NRT
    // search), and the route is part of the collapse key, the baseline read and
    // the coverage claim.
    const raw = (resp.data ?? [])[0]!;
    const o = norm.offers.find((x) => x.program === "alaska")!;
    expect(o.origin).toBe(raw.Route!.OriginAirport);
    expect(o.destination).toBe(raw.Route!.DestinationAirport);
  });

  it("derives bookableWith from our transfer table", () => {
    const as = norm.offers.find((o) => o.program === "alaska")!;
    expect(as.bookableWith).toEqual(["bilt"]);
    // Qatar folds onto avios, which all four currencies reach.
    const avios = norm.offers.find((o) => o.program === "avios")!;
    expect(avios.bookableWith!.sort()).toEqual(["bilt", "capital_one", "chase_ur", "citi_ty"]);
  });

  it("takes sourceFetchedAt from UpdatedAt, not from the fetch time", () => {
    // The cache timestamp is what lets a fresher row from another source
    // out-rank these in findsCte. Substituting the fetch time would make every
    // cached row look brand new.
    const as = norm.offers.find((o) => o.program === "alaska")!;
    expect(as.sourceFetchedAt).toBe(Date.parse("2026-08-09T13:58:49.539607Z"));
    expect(as.sourceFetchedAt).not.toBe(999);
  });

  it("never sets cashPriceCents — seats.aero sees no revenue fare", () => {
    for (const o of norm.offers) expect(o.cashPriceCents).toBeUndefined();
  });

  it("reports the furthest date it actually saw", () => {
    expect(norm.maxDate).toBe("2027-03-08");
  });
});

describe("parseQuotaHeaders", () => {
  it("reads remaining and limit", () => {
    const h = new Headers({ "x-ratelimit-remaining": "812", "x-ratelimit-limit": "1000" });
    expect(parseQuotaHeaders(h, "seatsaero", 1234)).toEqual({
      source: "seatsaero",
      remaining: 812,
      limit: 1000,
      observedAt: 1234,
    });
  });

  it("leaves limit undefined when the vendor does not state one", () => {
    const h = new Headers({ "x-ratelimit-remaining": "0" });
    expect(parseQuotaHeaders(h, "seatsaero", 1)).toEqual({
      source: "seatsaero",
      remaining: 0,
      limit: undefined,
      observedAt: 1,
    });
  });

  it("returns undefined rather than guessing when the header is missing", () => {
    expect(parseQuotaHeaders(new Headers(), "seatsaero", 1)).toBeUndefined();
    expect(
      parseQuotaHeaders(new Headers({ "x-ratelimit-remaining": "n/a" }), "seatsaero", 1),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Planning and running a search. These cases came over from a separate test
// file when the chunk-and-paginate loop moved into core so the Worker could
// drive it.
// ---------------------------------------------------------------------------

const TODAY = "2026-08-09";
const ROUTE = { origin: "SFO", destination: "NRT" };

/** A minimal Cached Search page. The full-shape fixture above is what exercises
 *  the parser; this only needs a furthest date and one droppable row, because
 *  what's under test is plan / paginate / claim-coverage. */
const row = (source: string, date: string) => ({
  Route: { OriginAirport: "SFO", DestinationAirport: "NRT", Source: source },
  Date: date,
  Source: source,
  TaxesCurrency: "USD",
  YAvailable: true,
  YMileageCost: 32500,
  YRemainingSeats: 2,
  YDirect: true,
  YAirlines: "AS",
  YTotalTaxes: 560,
  UpdatedAt: "2026-08-08T17:42:19Z",
});

// Dates sit inside the first planned chunk (2026-08-09..2026-11-06), because the
// truncation test is about narrowing a claim to dates actually seen.
const PAGE = {
  data: [row("alaska", "2026-08-15"), row("united", "2026-10-01"), row("smiles", "2026-09-20")],
  count: 3,
  hasMore: false,
  cursor: 0,
};

/** A fetch stub that serves canned pages and records what was asked for. */
function stubFetch(pages: unknown[], headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
    const body = pages[Math.min(urls.length - 1, pages.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { impl, urls };
}

/** What the Worker builds: one sticky transport for the whole search. */
const transportOver = (impl: (url: string) => Promise<Response>) =>
  makeTransport({ base: impl, expectJson: true });

describe("planSeatsAeroChunks", () => {
  // ~330 days, the shape of a year-out tracked route.
  const plan = () => planSeatsAeroChunks("2026-08-09", "2027-07-05", TODAY);

  it("chunks by date range, not by date — the whole economic argument", () => {
    // A per-date source would plan ~330 tasks and spend a third of the day's
    // 1000-call allowance on one route.
    const chunks = plan();
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.start).toBe("2026-08-09");
    expect(chunks.at(-1)!.end).toBe("2027-07-05");
    // Chunks tile the window without overlapping or leaving a gap.
    const all = chunks.flatMap((c) => datesIn(c.start, c.end));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(331);
  });

  it("clamps to the horizon rather than planning past it", () => {
    // A ten-year window is still capped at today+365, which five 90-day chunks
    // cover — so MAX_CHUNKS is never the thing doing the truncating.
    const chunks = planSeatsAeroChunks("2026-08-09", "2036-08-09", TODAY);
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(chunks.at(-1)!.end).toBe("2027-08-09");
  });

  it("plans nothing when the window lies entirely beyond the horizon", () => {
    expect(planSeatsAeroChunks("2029-01-01", "2029-02-01", TODAY)).toEqual([]);
  });

  it("gives every chunk a stable, unique key derived from the work", () => {
    const keys = (cs: { start: string; end: string }[]) =>
      cs.map((c) => seatsAeroTaskKey(ROUTE.origin, ROUTE.destination, c));
    expect(keys(plan())).toEqual(keys(plan()));
    expect(new Set(keys(plan())).size).toBe(plan().length);
    expect(keys(plan())[0]).toBe("seatsaero:SFO-NRT:2026-08-09..2026-11-06");
  });
});

describe("runSeatsAeroChunk", () => {
  const chunk = () => planSeatsAeroChunks("2026-08-09", "2027-07-05", TODAY)[0]!;
  const oneShot = { ...PAGE, hasMore: false };

  it("sends the key, parses offers, and reads the quota off the response", async () => {
    const { impl, urls } = stubFetch([oneShot], {
      "x-ratelimit-remaining": "812",
      "x-ratelimit-limit": "1000",
    });
    const c = chunk();
    const out = await runSeatsAeroChunk(c, {
      ...ROUTE,
      apiKey: "secret",
      transport: transportOver(impl),
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("origin_airport=SFO");
    expect(out.offers.length).toBeGreaterThan(0);
    expect(out.pages).toBe(1);
    expect(out.quota).toEqual({
      source: SEATSAERO_SOURCE_ID,
      remaining: 812,
      limit: 1000,
      observedAt: expect.any(Number),
    });
    // No truncation: the claim is the whole planned chunk.
    expect(out.truncated).toBe(false);
    expect(out.coveredDates).toEqual(datesIn(c.start, c.end));
    expect(out.notes.some((n) => n.includes("unmapped programs"))).toBe(true);
  });

  it("follows the cursor while hasMore", async () => {
    const page = { ...PAGE, hasMore: true, cursor: 77 };
    const { impl, urls } = stubFetch([page, page, { ...PAGE, hasMore: false }]);
    await runSeatsAeroChunk(chunk(), { ...ROUTE, apiKey: "k", transport: transportOver(impl) });

    expect(urls).toHaveLength(3);
    expect(urls[0]).not.toContain("cursor=");
    expect(urls[1]).toContain("cursor=77");
  });

  it("NARROWS the coverage claim when it paginates out with more remaining", async () => {
    // Results are ordered by departure date, so a truncated read loses the far
    // end of the window. Claiming the whole chunk anyway would let a later prune
    // delete real finds on dates we never saw.
    const endless = { ...PAGE, hasMore: true, cursor: 1 };
    const { impl, urls } = stubFetch([endless]);
    const c = chunk();
    const out = await runSeatsAeroChunk(c, {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
    });

    expect(urls).toHaveLength(SEATSAERO_MAX_PAGES);
    expect(out.truncated).toBe(true);
    expect(out.coveredDates.length).toBeLessThan(datesIn(c.start, c.end).length);
    expect(out.coveredDates.at(-1)).toBe("2026-10-01"); // furthest date seen
    expect(out.notes.some((n) => n.includes("coverage narrowed"))).toBe(true);
  });

  it("throws rather than returning empty when the API refuses", async () => {
    // Throwing is the failure protocol: `offers: []` with a coverage claim would
    // mean "I looked and there is nothing" and license a prune. A 401 (bad key)
    // classifies as blocked, not failed.
    const impl = async () =>
      new Response("nope", { status: 401, headers: { "content-type": "application/json" } });
    await expect(
      runSeatsAeroChunk(chunk(), { ...ROUTE, apiKey: "bad", transport: transportOver(impl) }),
    ).rejects.toThrow(/blocked/);
  });

  it("stops asking once the key has been refused, across chunks", async () => {
    // One transport for the whole search, so a 403 on chunk 1 doesn't cost four
    // more calls to be told the same thing.
    let calls = 0;
    const impl = async () => {
      calls++;
      return new Response("nope", { status: 403, headers: { "content-type": "application/json" } });
    };
    const transport = transportOver(impl);
    for (const c of planSeatsAeroChunks("2026-08-09", "2027-07-05", TODAY)) {
      await expect(runSeatsAeroChunk(c, { ...ROUTE, apiKey: "bad", transport })).rejects.toThrow(
        /blocked/,
      );
    }
    expect(calls).toBe(1);
  });

  it("notes a missing rate-limit header instead of inventing a number", async () => {
    const { impl } = stubFetch([oneShot]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
    });
    expect(out.quota).toBeUndefined();
    expect(out.notes.some((n) => n.includes("no x-ratelimit-remaining"))).toBe(true);
  });
});

describe("runSeatsAeroChunk — the call record", () => {
  const chunk = () => planSeatsAeroChunks("2026-08-09", "2027-07-05", TODAY)[0]!;
  const oneShot = { ...PAGE, hasMore: false };

  it("NEVER captures the API key", async () => {
    // The record is streamed to a browser and summarised into D1. This is the
    // one assertion in this file that is about a secret rather than about data.
    const { impl } = stubFetch([oneShot]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "super-secret-key",
      transport: transportOver(impl),
    });
    const serialized = JSON.stringify(out.calls);
    expect(serialized).not.toContain("super-secret-key");
    expect(out.calls[0]!.requestHeaders["Partner-Authorization"]).toBe(SEATSAERO_REDACTED);
    // The header actually sent is untouched — redaction is on the copy only.
    expect(seatsAeroHeaders("super-secret-key")["Partner-Authorization"]).toBe("super-secret-key");
  });

  it("records one call per page, in order, with timing and the body", async () => {
    const page = { ...PAGE, hasMore: true, cursor: 77 };
    const { impl } = stubFetch([page, page, { ...PAGE, hasMore: false }]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
    });

    expect(out.calls).toHaveLength(3);
    expect(out.calls.map((c) => c.index)).toEqual([1, 2, 3]);
    for (const c of out.calls) {
      expect(c.ok).toBe(true);
      expect(c.status).toBe(200);
      expect(c.rows).toBe(3);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(c.body!).data).toHaveLength(3);
      expect(c.responseHeaders!["content-type"]).toContain("application/json");
    }
    expect(out.calls[1]!.url).toContain("cursor=77");
  });

  it("hands each call to onCall as it finishes, not in a batch at the end", async () => {
    // The point of the callback is a live display, so page 1's record must arrive
    // BEFORE page 2's request goes out. Interleaving is the whole assertion.
    const page = { ...PAGE, hasMore: true, cursor: 5 };
    const order: string[] = [];
    const pages = [page, { ...PAGE, hasMore: false }];
    let n = 0;
    const impl = async () => {
      order.push(`fetch:${n + 1}`);
      const body = pages[n++]!;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
      onCall: (c) => void order.push(`call:${c.index}`),
    });

    expect(order).toEqual(["fetch:1", "call:1", "fetch:2", "call:2"]);
  });

  it("records a refused call — including the sticky one that never left", async () => {
    // A `blocked` chunk with no call record would look like it never tried, which
    // is exactly the ambiguity the whole task-status scheme exists to remove.
    let attempts = 0;
    const impl = async () => {
      attempts++;
      return new Response("nope", { status: 403, headers: { "content-type": "application/json" } });
    };
    const transport = transportOver(impl);
    const chunks = planSeatsAeroChunks("2026-08-09", "2027-07-05", TODAY);

    const first = await runSeatsAeroChunk(chunks[0]!, {
      ...ROUTE,
      apiKey: "bad",
      transport,
    }).catch((e: Error) => e);
    expect(first).toBeInstanceOf(Error);

    // The second chunk never reaches the network, and must still say so.
    const calls: SeatsAeroCall[] = [];
    await runSeatsAeroChunk(chunks[1]!, {
      ...ROUTE,
      apiKey: "bad",
      transport,
      onCall: (c) => void calls.push(c),
    }).catch(() => {});

    expect(attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(false);
    expect(calls[0]!.error).toContain("sticky");
    expect(calls[0]!.bytes).toBe(0);
    // No status, because nothing was asked. That is the difference between this
    // and the real refusal below, and the UI words the two differently.
    expect(calls[0]!.status).toBeUndefined();
  });

  it("keeps the status a refusal came back with", async () => {
    // 401 (wrong key) and 429 (out of allowance) need opposite fixes, and
    // makeTransport throws before the status reaches the normal path — so it has
    // to be recovered off BlockedError or the UI can only show a dash.
    const impl = async () =>
      new Response("nope", { status: 429, headers: { "content-type": "application/json" } });
    const calls: SeatsAeroCall[] = [];
    await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
      onCall: (c) => void calls.push(c),
    }).catch(() => {});

    expect(calls[0]!.status).toBe(429);
    expect(calls[0]!.ok).toBe(false);
  });

  it("captures a failing response's body, which is where the reason lives", async () => {
    const impl = async () =>
      new Response('{"error":"quota exceeded"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const calls: SeatsAeroCall[] = [];
    await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
      onCall: (c) => void calls.push(c),
    }).catch(() => {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(false);
    expect(calls[0]!.status).toBe(500);
    expect(calls[0]!.body).toContain("quota exceeded");
  });

  it("truncates rather than silently dropping when the budget runs out", async () => {
    const { impl } = stubFetch([oneShot]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
      maxCaptureBytes: 20,
    });
    expect(out.calls[0]!.body).toHaveLength(20);
    expect(out.calls[0]!.bodyTruncated).toBe(true);
    expect(out.capturedBytes).toBe(20);
  });

  it("still records the call when the body budget is entirely spent", async () => {
    // Knowing a call happened, and how long it took, matters more than reading it.
    const { impl } = stubFetch([oneShot]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "k",
      transport: transportOver(impl),
      maxCaptureBytes: 0,
    });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.body).toBeUndefined();
    expect(out.calls[0]!.bodyOmitted).toBe(true);
    expect(out.calls[0]!.rows).toBe(3);
    expect(out.capturedBytes).toBe(0);
  });

  it("callMetadata drops the body and keeps everything else", async () => {
    // This is what reaches search_tasks.capture_json — durable, small, and still
    // free of the key.
    const { impl } = stubFetch([oneShot]);
    const out = await runSeatsAeroChunk(chunk(), {
      ...ROUTE,
      apiKey: "super-secret-key",
      transport: transportOver(impl),
    });
    const meta = out.calls.map(callMetadata);
    expect(meta[0]).not.toHaveProperty("body");
    expect(meta[0]!.bytes).toBeGreaterThan(0);
    expect(meta[0]!.rows).toBe(3);
    expect(JSON.stringify(meta)).not.toContain("super-secret-key");
  });
});
