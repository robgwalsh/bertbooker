import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  classifyError,
  clientMessage,
  type FetchLike,
  makeTransport,
} from "../providers/transport.js";
import type { Env, Vars } from "../bindings.js";
import { rowIdParam } from "./params.js";
import { type ScopedRoute, withinRouteScope } from "../db/finds.js";
import { currentRows, enrichAvailability } from "../search/enrich.js";
import { ENRICH_MAX_PER_RUN } from "../../../shared/src/wire/enrich.js";

/**
 * The two HTTP shapes over `search/enrich.ts` — one find, or a whole route.
 *
 * Split from the engine for the same reason `endpoints/search.ts` is split from
 * `search/run.ts`: these two handlers answer very differently (a single-shot
 * JSON reply and a 100-line NDJSON stream) over one implementation of "buy the
 * itinerary behind this row".
 *
 * **Everything fallible happens before the stream opens** in the second one.
 * After the first byte the response is committed to 200 and an `error` frame is
 * all that is left, so a missing `SEATS_AERO_API_KEY` is a 503 and an unknown
 * route is a 404 — never an empty result.
 */
export const enrich = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Defined in `shared/src/wire/enrich.ts`, re-exported here for this module's
 *  consumers. */
export type { EnrichEvent } from "../../../shared/src/wire/enrich.js";
import type { EnrichEvent } from "../../../shared/src/wire/enrich.js";

enrich.post("/api/finds/enrich", async (c) => {
  const email = c.get("userEmail");
  const body = await c.req
    .json<{
      origin?: string;
      destination?: string;
      flightDate?: string;
      program?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "bad_request" }, 400);

  const origin = String(body.origin ?? "").toUpperCase();
  const destination = String(body.destination ?? "").toUpperCase();
  const flightDate = String(body.flightDate ?? "");
  const program = String(body.program ?? "");
  if (!origin || !destination || !flightDate || !program) {
    return c.json({ error: "bad_request" }, 400);
  }

  const apiKey = c.env.SEATS_AERO_API_KEY;
  if (!apiKey) return c.json({ error: "no_seats_aero_key" }, 503);

  // THE ROW MUST BE ONE OF THE CALLER'S TO ASK ABOUT.
  //
  // This is the only endpoint that names an availability row by its coordinates
  // instead of by a route id, and `currentRows` selects on those coordinates
  // alone — it never joins `tracked_routes`. So any (origin, destination, date,
  // program) in the database could be enriched: one metered seats.aero call and
  // a write to `finds`, repeatable without limit because the
  // per-row retry here is deliberately not gated on `enriched_at`. That made it
  // the cheapest way to drain the day's Partner-API quota, which in turn
  // silently disables the alert sweep for the rest of the UTC day.
  //
  // Checked against the same superset the Routes page reads through, so hub legs
  // and round-trip reversals still enrich — see `withinRouteScope`.
  //
  // Note what this is NOT: `search`'s deliberate no-budget rule is untouched.
  // Spending is still first-come; this only says whose rows you may spend it on.
  const { results: scopeRows } = await c.env.DB.prepare(
    `SELECT origin, destination, origins, destinations, via, date_start, date_end, round_trip
       FROM tracked_routes`,
  )
    .all<ScopedRoute>();
  if (!withinRouteScope(scopeRows ?? [], origin, destination, flightDate)) {
    // The same 404 an unknown row gets, deliberately: whether a row exists that
    // this account may not touch is not something the answer should reveal.
    return c.json({ error: "not_found" }, 404);
  }

  const rows = await currentRows(c.env.DB, origin, destination, flightDate, program);
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  if (!rows.some((r) => r.source_record_id)) {
    // The source exposed no id for this record, so there is no handle to buy an
    // itinerary with. A later search may write one.
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
    // `status` is this app's own vocabulary (blocked / failed / timeout) and the
    // UI keys off it, so it stays. `message` does not: `classifyError` hands back
    // the raw `err.message`, which for a refusal is `BlockedError`'s — and that
    // embeds the full seats.aero URL, query string included.
    const { status } = classifyError(err);
    return c.json({ error: "enrich_failed", status, message: clientMessage(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// A whole tracked route.
// ---------------------------------------------------------------------------

/** Defined in `shared/src/wire/enrich.ts`, re-exported here for this module's
 *  consumers. */

interface TargetRow {
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  source_record_id: string;
}

enrich.post("/api/tracked-routes/:id/enrich", async (c) => {
  const email = c.get("userEmail");
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);

  // Same rule as search: everything that can fail with a status code fails
  // BEFORE the stream opens, because after the first byte the response is
  // committed to 200 and an `error` frame is all that is left.
  const route = await c.env.DB.prepare(
    "SELECT id, origin, destination, date_start, date_end FROM tracked_routes WHERE id = ?",
  )
    .bind(id)
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
  //
  // `enriched_at IS NULL` means what it says: one row per slot, so there is no
  // superseded copy of it carrying a stale NULL and inviting a second metered
  // call for a slot that has already been expanded.
  //
  // Still open, and unrelated to any of that: the pair test uses the route's
  // PRIMARY airports only, so a multi-airport or hub route never bulk-enriches
  // its other pairs. That is a coverage gap, not a cost one.
  const { results: targets } = await c.env.DB.prepare(
    `SELECT origin, destination, flight_date, program, source_record_id
       FROM finds
      WHERE origin = ? AND destination = ? AND flight_date BETWEEN ? AND ?
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
    .bind(route.origin, route.destination, route.date_start, route.date_end)
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
    const transport: FetchLike = makeTransport();
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
      // Sanitised, for the same reason as the search stream — see
      // `clientMessage`. Nothing is recorded here because the per-row failures
      // already are.
      await write({ type: "error", message: clientMessage(err) }).catch(() => {});
    }
  });
});
