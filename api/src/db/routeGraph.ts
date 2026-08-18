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
