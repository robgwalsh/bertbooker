import type {
  RouteFetchRecord,
  RouteFetchStatus,
  RouteGraphEdge,
  RouteGraphRow,
} from "../models/wire/index.js";
import type { SeatsAeroGraphRoute } from "../providers/seatsaero.js";
import type { QueryReader } from "../util/params.js";
import type {
  GraphPair,
  GraphPathRow,
  PairSourceRow,
  PathQueryPair,
  RouteFetchOutcome,
} from "../models/routeGraph.js";

/**
 * Reads and writes for `seatsaero_routes` / `seatsaero_route_fetches`
 * SQL more than one surface shares, which is what `db/` is
 * for: the fetch endpoint writes it, the table, map, pair lookup and reach check
 * all read it.
 *
 * THE WRITE IS SHAPED BY TWO D1 CEILINGS, neither of them SQLite's familiar
 * 999-variable one:
 *
 *   - **100 bound parameters per query.** Eight columns per row means a naive
 *     multi-row `INSERT … VALUES` fits twelve rows.
 *   - **1,000 queries per Worker invocation**, and every statement inside a
 *     `batch()` counts toward it.
 *
 * A measured graph is ~8,300 rows, so the naive shape would be ~700 statements
 * for ONE source — within sight of the second ceiling, for no reason. Binding
 * the chunk as a single JSON parameter and expanding it with `json_each`
 * collapses that to two binds per statement regardless of row count: ~17
 * statements for a whole graph. SQLite's JSON1 functions are already relied on
 * by this schema (`origins`/`destinations` are JSON arrays, read through
 * `COALESCE(origins, json_array(origin))`), so this is an existing tool.
 */

/** Rows per INSERT. At ~90 bytes of JSON per row this is ~45 KB in one bind —
 *  well inside D1's 2 MB parameter ceiling, and it keeps a whole measured graph
 *  inside a single batch. */
export const ROUTE_INSERT_CHUNK = 500;

/**
 * Statements per `batch()`. A graph of ROUTE_INSERT_CHUNK × this, plus the
 * delete and the fetch record, is one atomic unit — which is the point:
 * `batch()` is a single implicit transaction, so delete-then-replace can never
 * be observed half-done and a failure leaves the previous graph standing.
 */
export const ROUTE_BATCH_STATEMENTS = 64;

/** Refuse rather than store a truncated graph. A short graph reads as a program
 *  that flies fewer places, and the reach check would then report confident
 *  false gaps — the one outcome worse than having no data at all. */
export const ROUTE_HARD_MAX = 250_000;

const FETCH_COLUMNS = `source, status, route_count, duplicate_rows, malformed_rows,
                       fetched_at, duration_ms, http_status, bytes, error`;

/**
 * Replace one source's graph and record the fetch, atomically.
 *
 * Order is the safety property: DELETE, then the inserts, then the fetch
 * record. The payload is the program's WHOLE network, so a merge would leave
 * pairs it has stopped flying standing forever.
 *
 * **Zero rows still deletes and still writes a record**, with status `empty`.
 * That is not an edge case to skip — it is the answer that says a source name is
 * not real, and skipping the write would recreate the exact "never asked vs
 * asked and got nothing" ambiguity this table exists to remove.
 */
export async function replaceSourceRoutes(
  db: D1Database,
  source: string,
  routes: SeatsAeroGraphRoute[],
  outcome: RouteFetchOutcome,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM seatsaero_routes WHERE source = ?").bind(source),
  ];

  for (let i = 0; i < routes.length; i += ROUTE_INSERT_CHUNK) {
    const chunk = routes.slice(i, i + ROUTE_INSERT_CHUNK);
    // One-letter keys: this JSON is a wire format between two lines of code, and
    // at 8,000 rows the long names would be most of the payload.
    const payload = JSON.stringify(
      chunk.map((r) => ({
        o: r.origin,
        d: r.destination,
        a: r.originRegion,
        b: r.destinationRegion,
        m: r.distanceMi,
        i: r.routeId,
      })),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO seatsaero_routes
             (source, origin, destination, origin_region, destination_region,
              distance_mi, route_id, fetched_at)
           SELECT ?1,
                  json_extract(value, '$.o'), json_extract(value, '$.d'),
                  json_extract(value, '$.a'), json_extract(value, '$.b'),
                  json_extract(value, '$.m'), json_extract(value, '$.i'),
                  ?2
             FROM json_each(?3)`,
        )
        .bind(source, outcome.fetchedAt, payload),
    );
  }

  statements.push(fetchRecordStatement(db, source, outcome));
  await db.batch(statements);
}

/** Record a fetch that stored nothing — a failure. The previous graph is left
 *  exactly where it was, because a refused call is not evidence about it. */
export async function recordRouteFetch(
  db: D1Database,
  source: string,
  outcome: RouteFetchOutcome,
): Promise<void> {
  await fetchRecordStatement(db, source, outcome).run();
}

function fetchRecordStatement(
  db: D1Database,
  source: string,
  o: RouteFetchOutcome,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO seatsaero_route_fetches (${FETCH_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         status         = excluded.status,
         route_count    = excluded.route_count,
         duplicate_rows = excluded.duplicate_rows,
         malformed_rows = excluded.malformed_rows,
         fetched_at     = excluded.fetched_at,
         duration_ms    = excluded.duration_ms,
         http_status    = excluded.http_status,
         bytes          = excluded.bytes,
         error          = excluded.error`,
    )
    .bind(
      source,
      o.status,
      o.routeCount,
      o.duplicates,
      o.malformed,
      o.fetchedAt,
      o.durationMs ?? null,
      o.httpStatus ?? null,
      o.bytes ?? null,
      o.error ?? null,
    );
}

export async function readFetchRecords(db: D1Database): Promise<RouteFetchRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${FETCH_COLUMNS} FROM seatsaero_route_fetches ORDER BY source`)
    .all<RouteFetchRecord>();
  return results;
}

/** The sources whose stored graph may be reasoned about. `failed` is excluded:
 *  its rows are whatever a previous fetch left behind, and an incomplete graph
 *  must never be read as evidence of absence. `empty` IS included — it reaches
 *  nothing, which is a real and correct contribution. */
export function fetchedSources(records: RouteFetchRecord[]): string[] {
  return records.filter((r) => r.status === "ok" || r.status === "empty").map((r) => r.source);
}

/**
 * Rows a self-join over the graph would return past D1's ceiling.
 *
 * Not a correctness bound — it is a runaway guard. The measured worst case for a
 * busy pair is 879 rows (JFK->LHR, one stop, any program), and the pairs this is
 * actually asked about are the exotic ones, where it is tens. A bulk sweep over
 * many pairs is what could reach this, and a truncated candidate set can only
 * under-report paths, never invent one.
 */
export const PATH_ROW_LIMIT = 20_000;

/**
 * Every (pair, source) row for a set of pairs, in one query.
 *
 * The pair list is bound as JSON for the same reason the insert is: a tracked
 * route can expand to many pairs, and one `?` per pair would hit D1's
 * 100-parameter ceiling at fifty of them. Hits `idx_sa_routes_pair`.
 */
export async function graphRowsForPairs(
  db: D1Database,
  pairs: readonly { origin: string; destination: string }[],
): Promise<GraphPair[]> {
  if (!pairs.length) return [];
  const payload = JSON.stringify(pairs.map((p) => ({ o: p.origin, d: p.destination })));
  const { results } = await db
    .prepare(
      `SELECT r.origin, r.destination, r.source
         FROM json_each(?1) k
         JOIN seatsaero_routes r
           ON r.origin = json_extract(k.value, '$.o')
          AND r.destination = json_extract(k.value, '$.d')`,
    )
    .bind(payload)
    .all<GraphPair>();
  return results;
}

/**
 * Every hub sequence joining a set of pairs, at one depth.
 *
 * The self-join `graphRowsForPairs` is not: `a.destination = b.origin` chained
 * `stops` times. Both directions are already indexed — `idx_sa_routes_pair`
 * leads on `origin` for the forward expansion and `idx_sa_routes_dest` on
 * `destination` for the backward one — so this needed **no new index and no
 * migration**. Measured on the live local graph: 3 ms at one stop, ~20 ms at
 * two.
 *
 * **`sameSource` is a claim about bookability, not a performance switch.** With
 * it, one program's own network covers every leg and the path is plausibly one
 * award. Without it, each leg may belong to a different program: real, but one
 * award per leg, two currencies, and the connection at the traveller's own risk.
 * Two stops is always `sameSource`, because three legs in three programs is
 * three award tickets — and because unrestricted it measured 240 ms and 14,485
 * rows on a busy pair, which is noise rather than an answer.
 *
 * The pair list is bound as ONE JSON parameter for the reason the insert is:
 * D1 allows 100 bound parameters per query, not SQLite's 999, and the reach
 * sweep asks about every pair it is still missing at once.
 */
export async function graphPathRowsForPairs(
  db: D1Database,
  pairs: readonly PathQueryPair[],
  opts: { stops: 1 | 2; sameSource: boolean },
): Promise<GraphPathRow[]> {
  if (!pairs.length) return [];
  const { stops, sameSource } = opts;
  const payload = JSON.stringify(
    pairs.map((p) => ({ o: p.origin, d: p.destination, b: p.budgetMi })),
  );

  const O = `json_extract(k.value, '$.o')`;
  const D = `json_extract(k.value, '$.d')`;
  // A null budget means "no bound", not "budget zero" — the difference between a
  // pair whose coordinates are unknown and one that may span nothing.
  const BUDGET = `COALESCE(json_extract(k.value, '$.b'), 1e9)`;
  const mi = (alias: string) => `COALESCE(${alias}.distance_mi, 0)`;
  const sourceMatch = (alias: string) => (sameSource ? `AND ${alias}.source = a.source` : "");

  const sql =
    stops === 1
      ? `SELECT ${O} AS origin, ${D} AS destination,
                a.destination AS hub1, NULL AS hub2,
                a.source AS s1, b.source AS s2, NULL AS s3
           FROM json_each(?1) k
           JOIN seatsaero_routes a
             ON a.origin = ${O} AND a.destination <> ${D}
           JOIN seatsaero_routes b
             ON b.origin = a.destination AND b.destination = ${D} ${sourceMatch("b")}
          WHERE ${mi("a")} + ${mi("b")} <= ${BUDGET}
          LIMIT ?2`
      : `SELECT ${O} AS origin, ${D} AS destination,
                a.destination AS hub1, b.destination AS hub2,
                a.source AS s1, b.source AS s2, c.source AS s3
           FROM json_each(?1) k
           JOIN seatsaero_routes a
             ON a.origin = ${O} AND a.destination <> ${D}
           JOIN seatsaero_routes b
             ON b.origin = a.destination ${sourceMatch("b")}
            AND b.destination <> ${D} AND b.destination <> ${O}
            AND b.destination <> a.destination
           JOIN seatsaero_routes c
             ON c.origin = b.destination AND c.destination = ${D} ${sourceMatch("c")}
          WHERE ${mi("a")} + ${mi("b")} + ${mi("c")} <= ${BUDGET}
          LIMIT ?2`;

  const { results } = await db
    .prepare(sql)
    .bind(payload, PATH_ROW_LIMIT)
    .all<{
      origin: string;
      destination: string;
      hub1: string;
      hub2: string | null;
      s1: string;
      s2: string;
      s3: string | null;
    }>();

  return results.map((r) => ({
    origin: r.origin,
    destination: r.destination,
    via: r.hub2 === null ? [r.hub1] : [r.hub1, r.hub2],
    legSources: r.s3 === null ? [r.s1, r.s2] : [r.s1, r.s2, r.s3],
  }));
}

// ---- the pane's reads -------------------------------------------------------

/**
 * Shared WHERE builder for the graph table and the graph map — the pair that
 * must never disagree about which set is on screen. Anonymous `?` binds pushed
 * in SQL order, so the readers below append their own (ORDER BY, LIMIT) only
 * AFTER these.
 *
 * `source` is REQUIRED here, unlike `airportFilter`'s "no query -> major
 * airports" default. A route graph is per-program by nature, and the
 * cross-source question has its own read (`selectPairSources`).
 *
 * Exported for its test, which is what `db/seatsaeroRoutes.test.ts` pins.
 */
export function routeFilter(query: QueryReader): {
  source: string;
  where: string[];
  binds: unknown[];
} {
  const source = (query("source") ?? "").trim().toLowerCase();
  const where: string[] = ["r.source = ?"];
  const binds: unknown[] = [source];

  const eq = (param: string, column: string) => {
    const v = (query(param) ?? "").trim().toUpperCase();
    if (!v) return;
    where.push(`r.${column} = ?`);
    binds.push(v);
  };
  eq("origin", "origin");
  eq("destination", "destination");

  const region = (param: string, column: string) => {
    const v = (query(param) ?? "").trim();
    if (!v) return;
    where.push(`r.${column} = ?`);
    binds.push(v);
  };
  region("originRegion", "origin_region");
  region("destinationRegion", "destination_region");

  const range = (param: string, op: string) => {
    const raw = query(param);
    if (raw === undefined || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    where.push(`r.distance_mi ${op} ?`);
    binds.push(n);
  };
  range("minDistance", ">=");
  range("maxDistance", "<=");

  const q = (query("q") ?? "").trim();
  if (q) {
    // One token, matched against either end of the pair. Deliberately simpler
    // than `airportFilter`'s multi-token AND: a route row is a pair, and
    // "SFO tokyo" would mean something this table cannot answer.
    if (/^[A-Za-z]{3}$/.test(q)) {
      // THREE LETTERS IS A CODE, and only a code.
      //
      // Substring-matching a three-letter token against airport names is close
      // to useless: "PIT" appears in "Aspen-Pitkin County", in "Beijing
      // CaPITal" and in "Cherry CaPITal", so asking for Pittsburgh returned
      // Aspen, Beijing and Traverse City. Short tokens are overwhelmingly codes
      // — the default-airport preference produces nothing else — so they are
      // treated as one, and anything longer keeps the name search below.
      const code = q.toUpperCase();
      where.push("(r.origin = ? OR r.destination = ?)");
      binds.push(code, code);
    } else {
      // `%` and `_` are LIKE metacharacters and `q` is whatever was typed. The
      // value is BOUND, so this was never injectable — but an unescaped pattern
      // is still a pattern the caller gets to write, and `%a%b%c%d%e%…` against
      // the joined seatsaero_routes × airports set makes both the COUNT(*) and
      // the row read below scan repeatedly. D1 bills rows read.
      const contains = `%${q.replace(/[\%_]/g, (ch) => `\${ch}`)}%`;
      where.push(
        `(ao.name LIKE ? ESCAPE '\' OR ad.name LIKE ? ESCAPE '\'
          OR ao.city LIKE ? ESCAPE '\' OR ad.city LIKE ? ESCAPE '\')`,
      );
      binds.push(contains, contains, contains, contains);
    }
  }

  return { source, where, binds };
}

/**
 * Join `airports` by IATA code, one row per code.
 */
const airportJoin = (alias: string, col: string) =>
  `LEFT JOIN airports ${alias} ON ${alias}.iata = ${col} AND ${alias}.iata != ''`;

/** Slim rows plus coordinates for the map, and the untruncated total beside
 *  them so the caller can say whether the limit bit. */
export async function selectGraphGeo(
  db: D1Database,
  filter: { where: string[]; binds: unknown[] },
  limit: number,
): Promise<{ edges: RouteGraphEdge[]; total: number }> {
  const from = `FROM seatsaero_routes r
                ${airportJoin("ao", "r.origin")}
                ${airportJoin("ad", "r.destination")}
                WHERE ${filter.where.join(" AND ")}`;

  const counted = await db
    .prepare(`SELECT COUNT(*) AS n ${from}`)
    .bind(...filter.binds)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT r.origin, r.destination,
              ao.latitude AS origin_lat, ao.longitude AS origin_lon,
              ad.latitude AS destination_lat, ad.longitude AS destination_lon
       ${from} LIMIT ?`,
    )
    .bind(...filter.binds, limit)
    .all<RouteGraphEdge>();

  return { edges: results, total: counted?.n ?? 0 };
}

/** Who flies this pair — an exact lookup across EVERY source, deliberately not
 *  routed through `routeFilter`: that builder is a source-scoped search, and
 *  this is the one question that is not about a single program. */
export async function selectPairSources(
  db: D1Database,
  origin: string,
  destination: string,
): Promise<PairSourceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT source, origin, destination, distance_mi
         FROM seatsaero_routes
        WHERE (origin = ?1 AND destination = ?2)
           OR (origin = ?2 AND destination = ?1)`,
    )
    .bind(origin, destination)
    .all<PairSourceRow>();
  return results;
}

/** The graph table read, with airport names joined for display. */
export async function selectGraphRows(
  db: D1Database,
  filter: { where: string[]; binds: unknown[] },
  limit: number,
): Promise<RouteGraphRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.source, r.origin, r.destination, r.origin_region, r.destination_region,
              r.distance_mi,
              ao.name AS origin_name, ao.city AS origin_city,
              ad.name AS destination_name, ad.city AS destination_city
         FROM seatsaero_routes r
         ${airportJoin("ao", "r.origin")}
         ${airportJoin("ad", "r.destination")}
        WHERE ${filter.where.join(" AND ")}
        ORDER BY r.origin, r.destination
        LIMIT ?`,
    )
    .bind(...filter.binds, limit)
    .all<RouteGraphRow>();
  return results;
}
