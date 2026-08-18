import { describe, expect, it } from "vitest";
import {
  ROUTE_INSERT_CHUNK,
  fetchedSources,
  recordRouteFetch,
  replaceSourceRoutes,
} from "./routeGraph.js";
import type { SeatsAeroGraphRoute } from "../providers/seatsaero.js";
import type { RouteFetchRecord } from "../../../shared/src/wire/index.js";

// A deliberately dumb D1 stub, in the style of `ingest/apply.test.ts`: it routes
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
