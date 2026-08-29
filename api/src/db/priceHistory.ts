import type { AvailabilityResult } from "../domain/types.js";
import { routeKey } from "../domain/types.js";

// The price series behind a find: one point per observed change, plus a point
// for the observation that it stopped existing.
//
// Written by `applyTask` alone, in the SAME BATCH as the snapshot write and the
// prune it accompanies -- `db.batch()` is one implicit transaction, so a price
// cannot be destroyed without the record of its disappearance landing with it.
//
// Enrichment does not appear here. `search/enrich.ts` rewrites `segments_json`,
// `stop_count`, `duration_minutes`, `booking_url` and `is_direct` and touches no
// price column, so it observes nothing this table records.
//
// Both writers bind a chunk as ONE JSON parameter and expand it with
// `json_each`, the idiom `db/routeGraph.ts` uses and for the same two reasons:
// D1 allows 100 bound parameters per query, and a statement per row would
// multiply the statement count of a batch that is already sized by the payload.

/** Rows per statement. A task rarely carries this many, but the payload is the
 *  caller's and nothing upstream caps it. */
const HISTORY_CHUNK = 500;

/** One-letter keys, as `routeGraph.ts` uses: the blob is bound as a parameter
 *  and every repeated key is bytes on the wire. */
interface HistoryJson {
  k: string;
  d: string;
  p: string;
  c: string;
  s: string;
  m: number | null;
  a: number | null;
  f: number | null;
  u: string | null;
  t: number | null;
}

const INSERT_SQL = `INSERT INTO price_history
    (route_key, flight_date, program, cabin, source, miles_cost, seats_available,
     cash_fees_cents, fees_currency, source_fetched_at, captured_at)
  SELECT json_extract(value, '$.k'), json_extract(value, '$.d'),
         json_extract(value, '$.p'), json_extract(value, '$.c'),
         json_extract(value, '$.s'), json_extract(value, '$.m'),
         json_extract(value, '$.a'), json_extract(value, '$.f'),
         json_extract(value, '$.u'), json_extract(value, '$.t'), ?2
    FROM json_each(?1)`;

/** A row's identity columns, shared by both writers. */
function identity(r: AvailabilityResult) {
  return {
    k: routeKey(r.origin, r.destination, r.flightDate),
    d: r.flightDate,
    p: r.program,
    c: r.cabin,
    s: r.source,
  };
}

function statements(
  db: D1Database,
  rows: HistoryJson[],
  capturedAt: number,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += HISTORY_CHUNK) {
    out.push(
      db.prepare(INSERT_SQL).bind(JSON.stringify(rows.slice(i, i + HISTORY_CHUNK)), capturedAt),
    );
  }
  return out;
}

/** A point per row whose price or seat count the source has just changed. */
export function priceStatements(
  db: D1Database,
  rows: AvailabilityResult[],
  capturedAt: number,
): D1PreparedStatement[] {
  return statements(
    db,
    rows.map((r) => ({
      ...identity(r),
      m: r.milesCost,
      a: r.seatsAvailable,
      f: r.cashFeesCents,
      u: r.feesCurrency ?? null,
      t: r.sourceFetchedAt,
    })),
    capturedAt,
  );
}

/**
 * A point per row the source has stopped reporting.
 *
 * Every price column is NULL, which is what makes the disappearance a POINT in
 * the series rather than the end of it -- and why the chart must break its line
 * here instead of drawing down to zero, which would read as a free seat.
 *
 * `source_fetched_at` is null for the same reason: the source did not report
 * this row, so there is no vendor timestamp for it. `captured_at` -- when WE
 * observed the absence -- is the only honest clock on a gone point.
 */
export function goneStatements(
  db: D1Database,
  rows: AvailabilityResult[],
  capturedAt: number,
): D1PreparedStatement[] {
  return statements(
    db,
    rows.map((r) => ({ ...identity(r), m: null, a: null, f: null, u: null, t: null })),
    capturedAt,
  );
}

/** One stored observation, as `readSlotHistory` projects it. */
export interface PriceHistoryRow {
  miles_cost: number | null;
  seats_available: number | null;
  cash_fees_cents: number | null;
  fees_currency: string | null;
  source: string;
  source_fetched_at: number | null;
  captured_at: number;
}

/** The whole series for one slot, oldest first -- an `idx_ph_slot` prefix seek.
 *  Across sources, because "what has this slot cost over time" is not a
 *  per-source question. */
export async function readSlotHistory(
  db: D1Database,
  route: string,
  program: string,
  cabin: string,
): Promise<PriceHistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT miles_cost, seats_available, cash_fees_cents, fees_currency,
              source, source_fetched_at, captured_at
         FROM price_history
        WHERE route_key = ? AND program = ? AND cabin = ?
        ORDER BY captured_at ASC`,
    )
    .bind(route, program, cabin)
    .all<PriceHistoryRow>();
  return results ?? [];
}
