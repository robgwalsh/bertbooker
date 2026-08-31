import { describe, expect, it } from "vitest";
import {
  PATH_ROW_LIMIT,
  ROUTE_INSERT_CHUNK,
  fetchedSources,
  graphPathRowsForPairs,
  recordRouteFetch,
  replaceSourceRoutes,
} from "./routeGraph.js";
import type { SeatsAeroGraphRoute } from "../providers/seatsaero.js";
import type { RouteFetchRecord } from "../models/wire/index.js";

// A deliberately dumb D1 stub, in the style of `features/search/apply.test.ts`: it routes
// on substring matches in the SQL and records the bound arguments. It is not a
// SQLite engine, and the assertions below are all about the STATEMENTS issued —
// their order, their count, and how many parameters each one binds.

interface Recorded {
  sql: string;
  args: unknown[];
}

function stubDb() {
  const batches: Recorded[][] = [];
  const runs: Recorded[] = [];

  const statement = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql,
      args,
      run: async () => {
        runs.push({ sql, args });
        return { meta: { changes: 1 } };
      },
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Recorded[]) => {
      batches.push(stmts);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;

  return { db, batches, runs };
}

const route = (origin: string, destination: string): SeatsAeroGraphRoute => ({
  source: "alaska",
  origin,
  destination,
  originRegion: "North America",
  destinationRegion: "Asia",
  distanceMi: 5130,
  routeId: `id-${origin}-${destination}`,
});

/** n distinct pairs, so nothing is deduped by accident. */
const routes = (n: number): SeatsAeroGraphRoute[] =>
  Array.from({ length: n }, (_, i) => route("SFO", `X${i}`));

const outcome = (routeCount: number) => ({
  status: routeCount ? ("ok" as const) : ("empty" as const),
  routeCount,
  duplicates: 0,
  malformed: 0,
  fetchedAt: 1_700_000_000_000,
});

describe("replaceSourceRoutes", () => {
  it("deletes the source's rows BEFORE inserting, in one batch", async () => {
    // Order is the safety property, and one batch is one implicit transaction:
    // a source can never be observed half-replaced, and a failure leaves the
    // previous graph standing.
    const { db, batches } = stubDb();
    await replaceSourceRoutes(db, "alaska", routes(3), outcome(3));

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch![0]!.sql).toContain("DELETE FROM seatsaero_routes");
    expect(batch![0]!.args).toEqual(["alaska"]);
    expect(batch![1]!.sql).toContain("INSERT INTO seatsaero_routes");
    expect(batch![batch!.length - 1]!.sql).toContain("seatsaero_route_fetches");
  });

  it("binds two parameters per insert regardless of row count", async () => {
    // The whole point of the json_each shape. D1 allows 100 bound parameters
    // per query; a naive multi-row VALUES insert with eight columns would fit
    // twelve rows and need ~700 statements for one measured graph.
    const { db, batches } = stubDb();
    await replaceSourceRoutes(db, "alaska", routes(ROUTE_INSERT_CHUNK * 2), outcome(1000));

    const inserts = batches[0]!.filter((s) => s.sql.includes("INSERT INTO seatsaero_routes"));
    expect(inserts).toHaveLength(2);
    for (const stmt of inserts) {
      expect(stmt.args).toHaveLength(3); // source, fetched_at, the JSON chunk
      expect(JSON.parse(stmt.args[2] as string)).toHaveLength(ROUTE_INSERT_CHUNK);
    }
  });

  it("never exceeds D1's 100-parameter ceiling on any statement", async () => {
    const { db, batches } = stubDb();
    await replaceSourceRoutes(db, "alaska", routes(8130), outcome(8130));
    for (const stmt of batches[0]!) expect(stmt.args.length).toBeLessThanOrEqual(100);
  });

  it("chunks without dropping or duplicating a row", async () => {
    const { db, batches } = stubDb();
    const all = routes(ROUTE_INSERT_CHUNK + 7);
    await replaceSourceRoutes(db, "alaska", all, outcome(all.length));

    const written = batches[0]!
      .filter((s) => s.sql.includes("INSERT INTO seatsaero_routes"))
      .flatMap((s) => JSON.parse(s.args[2] as string) as { o: string; d: string }[]);
    expect(written).toHaveLength(all.length);
    expect(new Set(written.map((w) => `${w.o}>${w.d}`)).size).toBe(all.length);
  });

  it("still deletes and still writes a record when zero routes come back", async () => {
    // The regression that would recreate the whole ambiguity: `200 []` means
    // "seats.aero does not recognise this name", and skipping the write would
    // make it indistinguishable from never having asked.
    const { db, batches } = stubDb();
    await replaceSourceRoutes(db, "britishairways", [], outcome(0));

    const [batch] = batches;
    expect(batch![0]!.sql).toContain("DELETE FROM seatsaero_routes");
    expect(batch!.filter((s) => s.sql.includes("INSERT INTO seatsaero_routes"))).toHaveLength(0);
    const record = batch![batch!.length - 1]!;
    expect(record.sql).toContain("seatsaero_route_fetches");
    expect(record.args[1]).toBe("empty");
    expect(record.args[2]).toBe(0);
  });
});

describe("recordRouteFetch", () => {
  it("writes a failure WITHOUT touching the stored graph", async () => {
    // A refused call is not evidence about a program's network, so the rows a
    // previous fetch stored stay exactly where they are.
    const { db, batches, runs } = stubDb();
    await recordRouteFetch(db, "alaska", {
      status: "failed",
      routeCount: 0,
      duplicates: 0,
      malformed: 0,
      fetchedAt: 1,
      error: "blocked: http 429",
    });

    expect(batches).toHaveLength(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain("seatsaero_route_fetches");
    expect(runs[0]!.sql).not.toContain("DELETE");
    expect(runs[0]!.args[1]).toBe("failed");
  });
});

describe("fetchedSources", () => {
  const record = (source: string, status: RouteFetchRecord["status"]): RouteFetchRecord => ({
    source,
    status,
    route_count: 0,
    duplicate_rows: 0,
    malformed_rows: 0,
    fetched_at: 1,
    duration_ms: null,
    http_status: null,
    bytes: null,
    error: null,
  });

  it("counts ok and empty, and excludes failed", () => {
    // `empty` reaches nothing, which is a real contribution. `failed` leaves
    // rows from some earlier fetch behind, and an incomplete graph must never
    // be read as evidence of absence.
    expect(
      fetchedSources([record("alaska", "ok"), record("ana", "empty"), record("delta", "failed")]),
    ).toEqual(["alaska", "ana"]);
  });
});

// ---- The reads ------------------------------------------------------------
//
// A second stub, because these care about what came BACK rather than what was
// issued. Still not a SQLite engine: the assertions are about the SQL's shape
// and about how the rows are mapped on the way out.

function stubReader(results: unknown[]) {
  const asked: Recorded[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        asked.push({ sql, args });
        return { all: async () => ({ results }) };
      },
    }),
  } as unknown as D1Database;
  return { db, asked };
}

describe("graphPathRowsForPairs", () => {
  const pair = { origin: "SFO", destination: "KTM", budgetMi: 11_400 };

  it("asks nothing at all for an empty pair list", async () => {
    const { db, asked } = stubReader([]);
    expect(await graphPathRowsForPairs(db, [], { stops: 1, sameSource: false })).toEqual([]);
    expect(asked).toHaveLength(0);
  });

  it("binds the whole pair list as ONE json parameter", async () => {
    // D1 allows 100 bound parameters per query, not SQLite's 999, and the reach
    // sweep asks about every pair it is still missing at once.
    const { db, asked } = stubReader([]);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...pair, destination: `X${i}` }));
    await graphPathRowsForPairs(db, many, { stops: 1, sameSource: false });

    expect(asked[0]!.args).toHaveLength(2); // the JSON, and the row limit
    expect(JSON.parse(asked[0]!.args[0] as string)).toHaveLength(60);
    expect(asked[0]!.args[1]).toBe(PATH_ROW_LIMIT);
  });

  it("joins the graph to itself once per stop", async () => {
    const one = stubReader([]);
    await graphPathRowsForPairs(one.db, [pair], { stops: 1, sameSource: false });
    expect(one.asked[0]!.sql.match(/JOIN seatsaero_routes/g)).toHaveLength(2);

    const two = stubReader([]);
    await graphPathRowsForPairs(two.db, [pair], { stops: 2, sameSource: true });
    expect(two.asked[0]!.sql.match(/JOIN seatsaero_routes/g)).toHaveLength(3);
  });

  it("constrains every leg to one source only when asked to", async () => {
    // `sameSource` is a claim about bookability, not a performance switch: with
    // it, one program's network covers the whole path and it is plausibly one
    // award.
    const off = stubReader([]);
    await graphPathRowsForPairs(off.db, [pair], { stops: 1, sameSource: false });
    expect(off.asked[0]!.sql).not.toContain("source = a.source");

    const on = stubReader([]);
    await graphPathRowsForPairs(on.db, [pair], { stops: 1, sameSource: true });
    expect(on.asked[0]!.sql).toContain("b.source = a.source");
  });

  it("carries each pair's own budget, and treats a null one as no bound", async () => {
    // One budget for every pair would be wrong the moment two pairs differ in
    // length, and a null budget must not collapse to zero.
    const { db, asked } = stubReader([]);
    await graphPathRowsForPairs(
      db,
      [pair, { origin: "PDX", destination: "GEG", budgetMi: null }],
      { stops: 1, sameSource: false },
    );
    expect(JSON.parse(asked[0]!.args[0] as string)).toEqual([
      { o: "SFO", d: "KTM", b: 11_400 },
      { o: "PDX", d: "GEG", b: null },
    ]);
    expect(asked[0]!.sql).toContain("COALESCE(json_extract(k.value, '$.b'), 1e9)");
  });

  it("maps a one-stop row to one hub and two leg sources", async () => {
    const { db } = stubReader([
      {
        origin: "SFO",
        destination: "KTM",
        hub1: "ICN",
        hub2: null,
        s1: "alaska",
        s2: "alaska",
        s3: null,
      },
    ]);
    expect(await graphPathRowsForPairs(db, [pair], { stops: 1, sameSource: false })).toEqual([
      { origin: "SFO", destination: "KTM", via: ["ICN"], legSources: ["alaska", "alaska"] },
    ]);
  });

  it("maps a two-stop row to two hubs and three leg sources, in order", async () => {
    // `legSources[i]` is the leg from `nodes[i]`; getting the order wrong would
    // attribute a leg to a program that does not fly it.
    const { db } = stubReader([
      {
        origin: "PIT",
        destination: "KTM",
        hub1: "JFK",
        hub2: "DOH",
        s1: "alaska",
        s2: "alaska",
        s3: "alaska",
      },
    ]);
    expect(await graphPathRowsForPairs(db, [pair], { stops: 2, sameSource: true })).toEqual([
      {
        origin: "PIT",
        destination: "KTM",
        via: ["JFK", "DOH"],
        legSources: ["alaska", "alaska", "alaska"],
      },
    ]);
  });
});
