import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import { type ScopedRoute, withinRouteScope } from "../db/finds.js";
import { readSlotHistory } from "../db/priceHistory.js";
import { routeKey } from "../domain/types.js";
import type { PriceHistory } from "../../../shared/src/wire/priceHistory.js";

/**
 * What one slot has cost over time.
 *
 * A pure read of `price_history` — this endpoint spends nothing and reaches no
 * vendor, which is what lets it answer on a click rather than behind a
 * confirmation the way enrichment does.
 *
 * Keyed on (route, date, program, cabin) rather than on a find, because that is
 * what `price_history` is keyed on and what OUTLIVES the find: once an award
 * disappears there is no current row to hang a series off, and the series is
 * exactly what is worth reading then.
 */
export const findHistory = new Hono<{ Bindings: Env; Variables: Vars }>();

findHistory.get("/api/finds/history", async (c) => {
  const email = c.get("userEmail");
  const q = c.req.query();
  const origin = String(q.origin ?? "").toUpperCase();
  const destination = String(q.destination ?? "").toUpperCase();
  const flightDate = String(q.flightDate ?? "");
  const program = String(q.program ?? "");
  const cabin = String(q.cabin ?? "");
  if (!origin || !destination || !flightDate || !program || !cabin) {
    return c.json({ error: "bad_request" }, 400);
  }

  // The same scope check `POST /api/finds/enrich` makes, for a weaker reason
  // and one that still holds: this costs no quota, so it is not draining
  // anything — but it names a row by coordinates alone, and without the check
  // it would read any slot in the database rather than the caller's own.
  const { results: scopeRows } = await c.env.DB.prepare(
    `SELECT origin, destination, origins, destinations, via, date_start, date_end, round_trip
       FROM tracked_routes WHERE user_email = ?`,
  )
    .bind(email)
    .all<ScopedRoute>();
  if (!withinRouteScope(scopeRows ?? [], origin, destination, flightDate)) {
    // As in `enrich`: whether a row exists that this account may not read is not
    // something the answer should reveal.
    return c.json({ error: "not_found" }, 404);
  }

  const points = await readSlotHistory(
    c.env.DB,
    routeKey(origin, destination, flightDate),
    program,
    cabin,
  );
  // An empty series is a legitimate answer, not a 404: a slot first seen after
  // 0009 has a point, and one whose route was only just added has none.
  const body: PriceHistory = { origin, destination, flightDate, program, cabin, points };
  return c.json(body);
});
