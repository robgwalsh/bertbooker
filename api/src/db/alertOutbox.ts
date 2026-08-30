import type { ChangeSummary } from "../models/change.js";

/**
 * The `alert_outbox` table — changes waiting for the next digest.
 *
 * It exists because "one digest per sweep cycle" and a tick that may not get
 * through the whole cycle only coexist if a change outlives the tick that found
 * it. See `features/alerts/outbox.ts`, which owns that argument; this module
 * owns only the three statements.
 *
 * `WITHOUT ROWID` on `(route_id, change_key)`, so filing a change costs one row
 * written rather than three.
 */

/** Rows per batch. D1 counts every statement in a `batch()` against its
 *  1,000-queries-per-invocation ceiling, and a sweep can file hundreds. */
const OUTBOX_BATCH = 50;

/** File changes for the next digest. Newest wins on conflict: a route swept
 *  twice before a flush must not report the same seat twice, and the later
 *  observation is the true one.
 *
 *  Keyed by `route_id` as well as `change_key` because two tracked routes can
 *  watch the same city pair with different filters and different recipients. */
export async function insertOutboxChanges(
  db: D1Database,
  routeId: number,
  changes: readonly ChangeSummary[],
): Promise<void> {
  const stmts = changes.map((c) =>
    db
      .prepare(
        `INSERT INTO alert_outbox
           (route_id, change_key, type, origin, destination, flight_date, program,
            cabin, miles_cost, seats, prev_miles, prev_seats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (route_id, change_key) DO UPDATE SET
           type = excluded.type, miles_cost = excluded.miles_cost,
           seats = excluded.seats, prev_miles = excluded.prev_miles,
           prev_seats = excluded.prev_seats`,
      )
      .bind(
        routeId,
        c.key,
        c.type,
        c.origin ?? "",
        c.destination ?? "",
        c.flightDate,
        c.program,
        c.cabin,
        c.milesCost ?? null,
        c.seatsAvailable ?? null,
        c.previousMilesCost ?? null,
        c.previousSeats ?? null,
      ),
  );
  for (let i = 0; i < stmts.length; i += OUTBOX_BATCH) {
    await db.batch(stmts.slice(i, i + OUTBOX_BATCH));
  }
}

/** Everything waiting, joined to the route that filed it.
 *
 *  THE ALIASES ARE LOAD-BEARING. `o.*` already yields `origin` and
 *  `destination` — the CHANGE's — and SQLite keeps the LAST column of a repeated
 *  name, so selecting `tr.origin` unaliased overwrote them with the route's
 *  primary pair and every line of every digest named the wrong city pair on any
 *  multi-airport, hub or round-trip route. */
export async function selectOutboxForDigest(
  db: D1Database,
): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT o.*, tr.alert_email,
              tr.origin AS route_origin, tr.destination AS route_destination,
              tr.origins, tr.destinations, tr.round_trip
         FROM alert_outbox o
         JOIN tracked_routes tr ON tr.id = o.route_id
        ORDER BY o.route_id, o.flight_date`,
    )
    .all<Record<string, unknown>>();
  return results ?? [];
}

/** Clear what a successful send actually told someone about. A refused send
 *  leaves the outbox intact so the next cycle tries again rather than losing it. */
export async function deleteOutboxForRoutes(
  db: D1Database,
  routeIds: readonly number[],
): Promise<void> {
  if (!routeIds.length) return;
  await db
    .prepare(`DELETE FROM alert_outbox WHERE route_id IN (${routeIds.map(() => "?").join(",")})`)
    .bind(...routeIds)
    .run();
}
