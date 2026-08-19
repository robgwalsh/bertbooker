import type {
  RouteFetchRecord,
  RouteFetchStatus,
} from "../../../shared/src/wire/index.js";
import type { SeatsAeroGraphRoute } from "../providers/seatsaero.js";

/**
 * Reads and writes for `seatsaero_routes` / `seatsaero_route_fetches`
 * (migrations/0003). SQL more than one surface shares, which is what `db/` is
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

export interface RouteFetchOutcome {
  status: RouteFetchStatus;
  routeCount: number;
  duplicates: number;
  malformed: number;
  fetchedAt: number;
  durationMs?: number | null;
  httpStatus?: number | null;
  bytes?: number | null;
  error?: string | null;
}

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

export interface GraphPair {
  origin: string;
  destination: string;
  source: string;
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

/** One pair to search paths for, with the budget its own great circle earns. */
export interface PathQueryPair {
  origin: string;
  destination: string;
  /** Total STORED `distance_mi` a path may span, or null for no bound (the pair
   *  has no coordinates, so no budget can be computed). A cheap pre-filter, not
   *  the authority: `distance_mi` has zeros, so this only ever lets too much
   *  through, which `rankPaths` then judges properly. */
  budgetMi: number | null;
}

/** One hub sequence for one asked pair, with the source flying each leg. */
export interface GraphPathRow {
  origin: string;
  destination: string;
  via: string[];
  /** One per leg, so `via.length + 1` of them. */
  legSources: string[];
}

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

/**
 * Coordinates for a set of airport codes.
 *
 * `airports.iata` is NOT unique, so this picks one row per code the way
 * `AIRPORT_PICK` in `endpoints/seatsaeroRoutes.ts` does — a plain join would
 * return a code twice and the caller would silently keep whichever arrived last.
 * Codes are bound as JSON for the same 100-parameter reason as everything else
 * here: a two-stop sweep resolves every endpoint and hub at once.
 */
export async function airportCoords(
  db: D1Database,
  codes: readonly string[],
): Promise<Map<string, { lat: number; lon: number }>> {
  const wanted = [...new Set(codes)].filter(Boolean);
  if (!wanted.length) return new Map();

  const { results } = await db
    .prepare(
      `SELECT a.iata, a.latitude, a.longitude
         FROM json_each(?1) k
         JOIN (SELECT iata, latitude, longitude FROM airports
                WHERE iata IS NOT NULL AND iata != ''
                GROUP BY iata) a
           ON a.iata = k.value`,
    )
    .bind(JSON.stringify(wanted))
    .all<{ iata: string; latitude: number | null; longitude: number | null }>();

  const out = new Map<string, { lat: number; lon: number }>();
  for (const row of results) {
    // A null coordinate is not a zero one. Null Island is in the Gulf of Guinea
    // and every distance measured from it would be wrong rather than missing.
    if (row.latitude === null || row.longitude === null) continue;
    out.set(row.iata, { lat: row.latitude, lon: row.longitude });
  }
  return out;
}
