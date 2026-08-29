import type { Cabin } from "../domain/types.js";
import {
  runSeatsAeroTrips,
  SEATSAERO_SOURCE_ID,
  type SeatsAeroTripDetail,
} from "../providers/seatsaero.js";
import { classifyError, type FetchLike, makeTransport } from "../providers/transport.js";
import { recordQuota } from "../db/runs.js";

/**
 * Buying the itinerary behind a summary find — the engine half.
 *
 * seats.aero's Cached Search answers a whole date range in one call, and the
 * price of that breadth is that a row says only "this cabin has space at this
 * price". `GET /trips/{id}` has the real legs, but costs **one call per
 * availability row** out of 1000 per UTC day — ruinous across a search, trivial
 * for the one row a person is actually looking at. So enrichment is not a
 * gathering step; it is a click.
 *
 * The HTTP shapes are `endpoints/enrich.ts`, split off for the same reason
 * `endpoints/search.ts` is separate from `search/run.ts`: two very different
 * response shapes (a single-shot JSON reply and an NDJSON stream) over one
 * engine.
 *
 * Three things this module deliberately does NOT do:
 *
 *  - **It claims no coverage and prunes nothing.** A coverage claim says "I
 *    looked at this slice and what I return is the complete truth for it", and
 *    enrichment looks at ONE row that was already looked at. Claiming here
 *    would license deleting every other row in that slice on the strength of a
 *    detail fetch that never asked about them.
 *  - **It writes no `search_runs` / `search_tasks` row.** The observable-task
 *    invariant is about unattended gathering, where a failure is otherwise
 *    indistinguishable from "there is no award space". A failure here goes
 *    straight back to the person who clicked, as a status code. What stays
 *    durable is `enriched_at` — the record that a call was spent.
 *  - **It never consults the quota before spending.** `source_quota` is a
 *    display only; only `alerts/budget.ts` reads it to decide whether to spend.
 */

/** Defined in `shared/src/wire/enrich.ts`, where the docblock lives. The SPA
 *  quotes the same constant in its confirm dialog instead of holding a second
 *  copy of the number. */
export { ENRICH_MAX_PER_RUN } from "../../../shared/src/wire/enrich.js";

/** One `availability_snapshots` row that could be enriched. */
export interface EnrichableRow {
  id: number;
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  cabin: string;
  miles_cost: number;
  source_record_id: string | null;
  detail_level: string;
}

/**
 * The latest seats.aero snapshot per cabin for one (route, date, program).
 *
 * Latest-per-cabin rather than "all rows": the table is append-on-change
 * history, and enriching a superseded row would decorate something no read path
 * will ever return. Mirrors the `MAX(captured_at)` join `loadPreviousForSource`
 * and `findsCte` both use, so all three agree on which row is current.
 */
export async function currentRows(
  db: D1Database,
  origin: string,
  destination: string,
  flightDate: string,
  program: string,
): Promise<EnrichableRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.origin, s.destination, s.flight_date, s.program, s.cabin,
              s.miles_cost, s.source_record_id, s.detail_level
         FROM availability_snapshots s
         JOIN (
           SELECT cabin, MAX(captured_at) AS mx
             FROM availability_snapshots
            WHERE origin = ? AND destination = ? AND flight_date = ?
              AND program = ? AND source = ?
            GROUP BY cabin
         ) latest ON latest.cabin = s.cabin AND latest.mx = s.captured_at
        WHERE s.origin = ? AND s.destination = ? AND s.flight_date = ?
          AND s.program = ? AND s.source = ?`,
    )
    .bind(
      origin,
      destination,
      flightDate,
      program,
      SEATSAERO_SOURCE_ID,
      origin,
      destination,
      flightDate,
      program,
      SEATSAERO_SOURCE_ID,
    )
    .all<EnrichableRow>();
  return results;
}

export type { EnrichOutcome } from "../../../shared/src/wire/enrich.js";
import type { EnrichOutcome } from "../../../shared/src/wire/enrich.js";

/**
 * Expand one availability row and write the result onto its snapshot rows.
 *
 * **Additive by construction.** `miles_cost`, `seats_available`,
 * `cash_fees_cents` and above all `raw_hash` are never touched: the row still
 * records what seats.aero's summary said, and `raw_hash` is what the next search
 * compares against. Rewrite it and the next search would see a changed row,
 * insert a fresh summary on top, and throw this call away — see the
 * `applyTask` write-on-change tests.
 *
 * `is_direct` and `stops` DO come from the chosen trip. They are consistent with
 * the price by construction (only equally-priced trips were candidates), and the
 * itinerary is better evidence about stops than a rolled-up boolean.
 */
export async function enrichAvailability(
  db: D1Database,
  apiKey: string,
  rows: EnrichableRow[],
  opts: { transport?: FetchLike; signal?: AbortSignal; now?: number } = {},
): Promise<EnrichOutcome> {
  const now = opts.now ?? Date.now();
  const availabilityId = rows.find((r) => r.source_record_id)?.source_record_id;
  if (!availabilityId) throw new Error("no source_record_id on any row");

  // What the stored rows claim, per cabin. This is what makes a returned trip
  // *this* find rather than a dearer one sharing the same availability id.
  const milesByCabin: Partial<Record<Cabin, number>> = {};
  for (const r of rows) milesByCabin[r.cabin as Cabin] = r.miles_cost;

  const out = await runSeatsAeroTrips(
    { availabilityId, milesByCabin },
    { apiKey, transport: opts.transport, signal: opts.signal },
  );
  if (out.quota) await recordQuota(db, [out.quota]);

  const byCabin = new Map<string, SeatsAeroTripDetail>(out.details.map((d) => [d.cabin, d]));
  const enriched: EnrichOutcome["enriched"] = [];
  const skipped: EnrichOutcome["skipped"] = [];
  const writes: D1PreparedStatement[] = [];

  for (const row of rows) {
    const detail = byCabin.get(row.cabin);
    if (!detail) {
      // Stamp enriched_at anyway. The difference between "not tried" and "tried,
      // seats.aero had no itinerary at this price" is the difference between an
      // inviting button and one that says so — without it the UI would offer the
      // same wasted call forever.
      writes.push(
        db
          .prepare("UPDATE availability_snapshots SET enriched_at = ? WHERE id = ?")
          .bind(now, row.id),
      );
      skipped.push({ cabin: row.cabin, reason: "no trip at the stored price" });
      continue;
    }

    writes.push(
      db
        .prepare(
          `UPDATE availability_snapshots SET
             segments_json = ?, stop_count = ?, duration_minutes = ?,
             booking_url = COALESCE(?, booking_url), is_direct = ?,
             detail_level = 'itinerary', enriched_at = ?
           WHERE id = ?`,
        )
        .bind(
          JSON.stringify(detail.segments),
          // An enriched row's stop count is never a guess — it came off the
          // itinerary — so leaving stop_count NULL here would downgrade a fact
          // to "unknown" the moment the detail arrived.
          detail.stops,
          detail.durationMinutes ?? null,
          detail.bookingUrl ?? null,
          detail.stops === 0 ? 1 : 0,
          now,
          row.id,
        ),
    );
    enriched.push({
      cabin: row.cabin,
      stops: detail.stops,
      durationMinutes: detail.durationMinutes,
      flights: detail.segments.map((s) => s.flightNumber ?? s.carrier).join(", "),
    });
  }

  if (writes.length) await db.batch(writes);
  return { enriched, skipped, notes: out.notes, quotaRemaining: out.quota?.remaining };
}

// ---------------------------------------------------------------------------
// One find.
// ---------------------------------------------------------------------------

/**
 * Enrich the availability row behind one find.
 *
 * Takes no cabin, on purpose: one seats.aero id covers all four cabins of a
 * (route, date, program), so the call the user is paying for expands every
 * sibling row too. Charging them for economy and leaving business a summary
 * would waste the more expensive half of the response.
 */
