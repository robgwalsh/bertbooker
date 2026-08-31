import type { Cabin } from "../../models/availability.js";
import {
  runSeatsAeroTrips,
  type SeatsAeroTripDetail,
} from "../../providers/seatsaero.js";
import { classifyError, type FetchLike, makeTransport } from "../../providers/transport.js";
import { recordQuota } from "../../db/sourceQuota.js";
import {
  enrichItineraryStatement,
  stampEnrichAttemptStatement,
} from "../../db/finds.js";
import type { EnrichableRow } from "../../models/find.js";

export type { EnrichableRow } from "../../models/find.js";

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
 * The HTTP shapes are `endpoints/enrich-endpoints.ts`, split off for the same reason
 * `endpoints/search-endpoints.ts` is separate from `features/search/run.ts`: two very different
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
 *  - **It writes no `runs` row.** The observable-task
 *    invariant is about unattended gathering, where a failure is otherwise
 *    indistinguishable from "there is no award space". A failure here goes
 *    straight back to the person who clicked, as a status code. What stays
 *    durable is `enriched_at` — the record that a call was spent.
 *  - **It never consults the quota before spending.** `source_quota` is a
 *    display only; only `alerts/budget.ts` reads it to decide whether to spend.
 */

/** Defined in `api/src/models/wire/enrich.ts`, where the docblock lives. The SPA
 *  quotes the same constant in its confirm dialog instead of holding a second
 *  copy of the number. */
export { ENRICH_MAX_PER_RUN } from "../../models/wire/enrich.js";

export type { EnrichOutcome } from "../../models/wire/enrich.js";
import type { EnrichOutcome } from "../../models/wire/enrich.js";

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
  // Which cabin each write is for, index-aligned with `writes`, so a write the
  // raw_hash guard rejects can be reported instead of silently claimed. Null is
  // the "tried, nothing at this price" stamp, which nothing promised the user.
  const writeCabin: (string | null)[] = [];

  for (const row of rows) {
    const detail = byCabin.get(row.cabin);
    if (!detail) {
      // Stamp enriched_at anyway. The difference between "not tried" and "tried,
      // seats.aero had no itinerary at this price" is the difference between an
      // inviting button and one that says so — without it the UI would offer the
      // same wasted call forever.
      writes.push(stampEnrichAttemptStatement(db, row, now));
      writeCabin.push(null);
      skipped.push({ cabin: row.cabin, reason: "no trip at the stored price" });
      continue;
    }

    writes.push(
      enrichItineraryStatement(
        db,
        row,
        {
          segmentsJson: JSON.stringify(detail.segments),
          // An enriched row's stop count is never a guess — it came off the
          // itinerary — so leaving stop_count NULL would downgrade a fact to
          // "unknown" the moment the detail arrived.
          stops: detail.stops,
          durationMinutes: detail.durationMinutes ?? null,
          bookingUrl: detail.bookingUrl ?? null,
        },
        now,
      ),
    );
    writeCabin.push(row.cabin);
    enriched.push({
      cabin: row.cabin,
      stops: detail.stops,
      durationMinutes: detail.durationMinutes,
      flights: detail.segments.map((s) => s.flightNumber ?? s.carrier).join(", "),
    });
  }

  if (writes.length) {
    // The raw_hash guard makes a write conditional, so a landed batch is no
    // longer proof the row was decorated. A search can upsert a new price into
    // this exact row while the metered call is in flight; the itinerary we got
    // back was chosen against the OLD price (see `pickDetail`), so the guard
    // correctly refuses it — and reporting an enrichment that did not happen
    // would leave the UI showing legs the row does not carry.
    const results = await db.batch(writes);
    const lost = new Set<string>();
    results.forEach((res, i) => {
      const cabin = writeCabin[i];
      if (cabin != null && (res.meta.changes ?? 0) === 0) lost.add(cabin);
    });
    if (lost.size) {
      for (let i = enriched.length - 1; i >= 0; i--) {
        if (lost.has(enriched[i]!.cabin)) enriched.splice(i, 1);
      }
      for (const cabin of lost) {
        skipped.push({ cabin, reason: "the price changed while we were fetching" });
      }
    }
  }
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
