import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  classifyError,
  makeTransport,
  runSeatsAeroTrips,
  SEATSAERO_SOURCE_ID,
  type Cabin,
  type FetchLike,
  type SeatsAeroTripDetail,
  type SourceTaskStatus,
} from "../../shared/src/index.js";
import type { Env, Vars } from "./bindings.js";
import { recordQuota } from "./searchRun.js";

/**
 * Buying the itinerary behind a summary find.
 *
 * seats.aero's Cached Search answers a whole date range in one call, and the
 * price of that breadth is that a row says only "this cabin has space at this
 * price". `GET /trips/{id}` has the real legs, but costs **one call per
 * availability row** out of 1000 per UTC day — ruinous across a search, trivial
 * for the one row a person is actually looking at. So enrichment is not a
 * gathering step; it is a click.
 *
 * Three things this module deliberately does NOT do:
 *
 *  - **It claims no coverage and prunes nothing.** `search_coverage` answers
 *    "did anyone look at (route, date, program)", and enrichment looks at a row
 *    that was already looked at. Writing a coverage row here would move a find's
 *    freshness forward without re-checking whether the seat still exists, which
 *    is exactly the lie the coverage table exists to prevent.
 *  - **It writes no `search_runs` / `search_tasks` row.** The observable-task
 *    invariant is about unattended gathering, where a failure is otherwise
 *    indistinguishable from "there is no award space". A failure here goes
 *    straight back to the person who clicked, as a status code. What stays
 *    durable is `enriched_at` — the record that a call was spent.
 *  - **It never consults the quota before spending.** `source_quota` is a
 *    display. Code that reads it to refuse a call is the deleted budget guard
 *    coming back.
 */
export const enrich = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Defined in `shared/src/wire/enrich.ts`, where the docblock lives. The SPA
 *  quotes the same constant in its confirm dialog instead of holding a second
 *  copy of the number. */
export { ENRICH_MAX_PER_RUN } from "../../shared/src/wire/enrich.js";
import { ENRICH_MAX_PER_RUN } from "../../shared/src/wire/enrich.js";

/** One `availability_snapshots` row that could be enriched. */
interface EnrichableRow {
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
async function currentRows(
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

export type { EnrichOutcome } from "../../shared/src/wire/enrich.js";
import type { EnrichOutcome } from "../../shared/src/wire/enrich.js";

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
enrich.post("/api/finds/enrich", async (c) => {
  const body = await c.req.json<{
    origin?: string;
    destination?: string;
    flightDate?: string;
    program?: string;
  }>();

  const origin = String(body.origin ?? "").toUpperCase();
  const destination = String(body.destination ?? "").toUpperCase();
  const flightDate = String(body.flightDate ?? "");
  const program = String(body.program ?? "");
  if (!origin || !destination || !flightDate || !program) {
    return c.json({ error: "bad_request" }, 400);
  }

  const apiKey = c.env.SEATS_AERO_API_KEY;
  if (!apiKey) return c.json({ error: "no_seats_aero_key" }, 503);

  const rows = await currentRows(c.env.DB, origin, destination, flightDate, program);
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  if (!rows.some((r) => r.source_record_id)) {
    // Rows written before the id was kept. A search re-writes them; migration
    // 0011 cleared their raw_hash precisely so that happens on the next one.
    return c.json({ error: "not_enrichable" }, 409);
  }

  try {
    const out = await enrichAvailability(c.env.DB, apiKey, rows, { signal: c.req.raw.signal });
    return c.json(out);
  } catch (err) {
    // Reported straight back to whoever clicked, with the distinction intact:
    // `blocked` at 401 is a wrong key, at 429 a spent day, and `failed` is
    // seats.aero having a bad time. Nothing is stamped, so the row stays
    // offering to try again.
    const { status, message } = classifyError(err);
    return c.json({ error: "enrich_failed", status, message }, 502);
  }
});

// ---------------------------------------------------------------------------
// A whole tracked route.
// ---------------------------------------------------------------------------

/** Defined in `shared/src/wire/enrich.ts`, re-exported here for this module's
 *  consumers. Both halves used to be written down twice. */
export type { EnrichEvent } from "../../shared/src/wire/enrich.js";
import type { EnrichEvent } from "../../shared/src/wire/enrich.js";

interface TargetRow {
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  source_record_id: string;
}

enrich.post("/api/tracked-routes/:id/enrich", async (c) => {
  const email = c.get("userEmail");
  const id = Number(c.req.param("id"));

  // Same rule as search: everything that can fail with a status code fails
  // BEFORE the stream opens, because after the first byte the response is
  // committed to 200 and an `error` frame is all that is left.
  const route = await c.env.DB.prepare(
    "SELECT id, origin, destination, date_start, date_end FROM tracked_routes WHERE id = ? AND user_email = ?",
  )
    .bind(id, email)
    .first<{ id: number; origin: string; destination: string; date_start: string; date_end: string }>();
  if (!route) return c.json({ error: "not_found" }, 404);

  const apiKey = c.env.SEATS_AERO_API_KEY;
  if (!apiKey) return c.json({ error: "no_seats_aero_key" }, 503);

  // One row per availability id, not per find: four summary cabins share an id
  // and cost one call between them. Ordered by date so a capped run enriches the
  // near dates first, which are the ones being booked.
  //
  // `enriched_at IS NULL` is what stops a sweep re-buying nothing. A cabin
  // seats.aero had no itinerary for stays `summary` forever, so without this it
  // would be a target on every run — the same call, the same empty answer, out
  // of the same 1000. The per-row button still offers a deliberate retry; a bulk
  // sweep should not spend the day's allowance on a known miss.
  //
  // Two kinds of row are worth a call, and the second only exists since the
  // search started asking for `include_trips`:
  //
  //   1. a `summary` — no itinerary at all;
  //   2. an `itinerary` MISSING ITS PER-LEG TIMES. A trip embedded in a search
  //      response carries only the whole trip's endpoints, so a connecting award
  //      arrives knowing which aeroplanes and via where, but not when it lands
  //      between them. `/trips/{id}` is still the only source of that, and it is
  //      what turns an unknown connection into a measured layover.
  //
  // Detected as "leg two exists and has no departure", which is exactly the
  // shape a chain-rebuilt itinerary has. A nonstop is fully timed already and is
  // never a target.
  const { results: targets } = await c.env.DB.prepare(
    `SELECT origin, destination, flight_date, program, source_record_id
       FROM availability_snapshots
      WHERE origin = ? AND destination = ? AND source = ?
        AND flight_date BETWEEN ? AND ?
        AND source_record_id IS NOT NULL
        AND enriched_at IS NULL
        AND (
          detail_level = 'summary'
          OR (json_array_length(segments_json) > 1
              AND json_extract(segments_json, '$[1].departsAt') IS NULL)
        )
      GROUP BY source_record_id
      ORDER BY flight_date ASC, program ASC`,
  )
    .bind(route.origin, route.destination, SEATSAERO_SOURCE_ID, route.date_start, route.date_end)
    .all<TargetRow>();

  if (targets.length === 0) return c.json({ error: "nothing_to_enrich" }, 400);

  const totalTargets = targets.length;
  const capped = totalTargets > ENRICH_MAX_PER_RUN;
  const batch = targets.slice(0, ENRICH_MAX_PER_RUN);
  const startedAt = Date.now();

  c.header("content-type", "application/x-ndjson");
  c.header("cache-control", "no-store");
  c.header("x-accel-buffering", "no");

  return stream(c, async (s) => {
    const write = (e: EnrichEvent) => s.write(`${JSON.stringify(e)}\n`);

    // ONE transport for the run: a refused key is a fact about the source, not
    // about one row, and `makeTransport` is sticky — so a 401 on the first item
    // costs one call, not twenty-five.
    const transport: FetchLike = makeTransport({ expectJson: true });
    const totals = { enriched: 0, failed: 0, empty: 0, calls: 0 };
    let lastQuota: number | undefined;

    try {
      await write({ type: "run_start", targets: batch.length, totalTargets, capped });

      for (let i = 0; i < batch.length; i++) {
        const t = batch[i]!;
        const rows = await currentRows(
          c.env.DB,
          t.origin,
          t.destination,
          t.flight_date,
          t.program,
        );

        // Raced with a search that rewrote the rows, or already enriched by
        // another tab. Not a failure; there is simply nothing left to buy.
        if (rows.length === 0 || !rows.some((r) => r.source_record_id)) {
          await write({
            type: "item",
            index: i,
            total: batch.length,
            flightDate: t.flight_date,
            program: t.program,
            status: "empty",
            cabins: [],
          });
          continue;
        }

        try {
          const out = await enrichAvailability(c.env.DB, apiKey, rows, {
            transport,
            signal: c.req.raw.signal,
          });
          totals.calls += 1;
          totals.enriched += out.enriched.length;
          totals.empty += out.skipped.length;
          await write({
            type: "item",
            index: i,
            total: batch.length,
            flightDate: t.flight_date,
            program: t.program,
            status: out.enriched.length ? "ok" : "empty",
            cabins: out.enriched.map((e) => e.cabin),
          });
          if (out.quotaRemaining != null && out.quotaRemaining !== lastQuota) {
            lastQuota = out.quotaRemaining;
            await write({
              type: "quota",
              remaining: out.quotaRemaining,
              observedAt: Date.now(),
            });
          }
        } catch (err) {
          // One row failing does not end the run — the next id may be fine. A
          // sticky transport is what stops that being 25 doomed calls when the
          // key itself was refused.
          const { status, message } = classifyError(err);
          totals.calls += 1;
          totals.failed += 1;
          await write({
            type: "item",
            index: i,
            total: batch.length,
            flightDate: t.flight_date,
            program: t.program,
            status,
            cabins: [],
            error: message,
          });
        }

        if (c.req.raw.signal.aborted) break;
      }

      await write({
        type: "run_done",
        enriched: totals.enriched,
        failed: totals.failed,
        empty: totals.empty,
        calls: totals.calls,
        durationMs: Date.now() - startedAt,
        capped,
        // What is left for a second run — the "no silent caps" half of the
        // contract, so the UI can say "25 of 63" rather than implying it is done.
        remaining: Math.max(0, totalTargets - batch.length),
      });
    } catch (err) {
      // A stream ending with neither `run_done` nor `error` died mid-flight, and
      // the client must read that as failure rather than as an empty result.
      const message = err instanceof Error ? err.message : String(err);
      await write({ type: "error", message }).catch(() => {});
    }
  });
});
