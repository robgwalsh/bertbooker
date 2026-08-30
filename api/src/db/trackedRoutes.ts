import type { TrackedRoute } from "../../../shared/src/wire/index.js";
import type { ScopedRoute } from "./finds.js";

/**
 * The `tracked_routes` table — the saved searches everything else hangs off.
 *
 * One module for one table, so the several surfaces that read it cannot grow two
 * versions of the same projection. They legitimately project DIFFERENT column
 * lists, and each has its own function and its own row type here: the Routes
 * page needs every settable column, the search planner needs nine, the sweep
 * needs the alert clocks, and the reach report needs six.
 *
 * **`tracked_routes` carries no index at all, and should not grow one.** Seven
 * rows, and "which route is most overdue" is not SQL — `dueRoutes` is a pure
 * function over rows already in memory. An index here would only make the
 * pacing-clock UPDATE bill two D1 rows instead of one.
 *
 * Nothing in this file decides anything. The three-valued merge behind the PATCH
 * (absent keeps, `null` clears, a value sets), every clamp, and the rule that an
 * empty `alert_on` is refused rather than stored all live with the handler that
 * parses the request.
 */

/** The whole row, for the list the SPA renders. */
export async function selectAllTrackedRoutes(db: D1Database): Promise<TrackedRoute[]> {
  const { results } = await db
    .prepare("SELECT * FROM tracked_routes ORDER BY created_at DESC")
    .all<TrackedRoute>();
  return results;
}

/** The whole row as stored, for PATCH's merge base. `Record<string, unknown>`
 *  rather than `TrackedRoute` because the merge reads columns the wire type does
 *  not carry, and reads them defensively. */
export async function selectTrackedRouteRow(
  db: D1Database,
  id: number,
): Promise<Record<string, unknown> | null> {
  return await db
    .prepare("SELECT * FROM tracked_routes WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

/** A route as it is written on create. Every value here has already been
 *  validated, normalized and clamped by the caller. */
export interface NewTrackedRoute {
  /** The PRIMARY airport of each side. NOT NULL, and `runs` records them the
   *  same way, so a run can be read back against the route it was of. */
  origin: string;
  destination: string;
  /** The authoritative sets, as JSON. */
  origins: string;
  destinations: string;
  /** JSON, or null for no hubs — null rather than `"[]"` so the column reads the
   *  way `cabins` and `currencies` do. */
  via: string | null;
  dateStart: string;
  dateEnd: string;
  /** NULL (not `"[]"`) when there is no filter, so downstream "no filter" checks
   *  treat an empty selection as "any cabin". Same rule for `currencies`. */
  cabins: string | null;
  minSeats: number;
  currencies: string | null;
  directOnly: number;
  /** NULL = no limit, which is what a route with no opinion gets. */
  pointLimit: number | null;
  /** Unlike every other flag here, this one changes what a search GATHERS: both
   *  directions in the one call. */
  roundTrip: number;
  /** ...and so does this one: it enrolls the route in the cron sweep. */
  alertsEnabled: number;
  alertEmail: string | null;
  /** NULL means the default set. `[]` is refused at the handler rather than
   *  stored as "never fire". */
  alertOn: string | null;
  alertMinDropPct: number;
}

export async function insertTrackedRoute(
  db: D1Database,
  v: NewTrackedRoute,
): Promise<number | undefined> {
  const res = await db
    .prepare(
      `INSERT INTO tracked_routes
         (origin, destination, origins, destinations, via,
          date_start, date_end, cabins, min_seats, currencies, direct_only,
          point_limit, round_trip, alerts_enabled, alert_email, alert_on, alert_min_drop_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      v.origin,
      v.destination,
      v.origins,
      v.destinations,
      v.via,
      v.dateStart,
      v.dateEnd,
      v.cabins,
      v.minSeats,
      v.currencies,
      v.directOnly,
      v.pointLimit,
      v.roundTrip,
      v.alertsEnabled,
      v.alertEmail,
      v.alertOn,
      v.alertMinDropPct,
    )
    .first<{ id: number }>();
  return res?.id;
}

/** A route as it is written on edit: the whole row, already merged. */
export interface EditedTrackedRoute extends NewTrackedRoute {
  /** Representative value for any `SELECT *` reader; `cabins` is the filter. */
  cabin: string;
  /** What `alert_last_digest_at` becomes IF alerts are turning ON. Only consulted
   *  by the CASE below, i.e. only on an OFF -> ON transition. */
  baselineDigestAt: number | null;
}

/**
 * Write the merged row back.
 *
 * A whole-row write rather than a per-column patch, because `normalizeSpec`
 * validates the airport sets as one shape and so has to be handed the route the
 * caller means to end up with. The merge itself is the handler's job; by the
 * time a value reaches here it is what will be stored.
 *
 * Nothing here touches a find, a coverage claim or `last_checked_at`. Editing a
 * route re-asks the question; it never invalidates an answer.
 */
export async function updateTrackedRoute(
  db: D1Database,
  id: number,
  v: EditedTrackedRoute,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tracked_routes
          SET origin = ?, destination = ?, origins = ?, destinations = ?, via = ?,
              date_start = ?, date_end = ?,
              cabin = ?, cabins = ?, currencies = ?, min_seats = ?, direct_only = ?,
              point_limit = ?,
              round_trip = ?,
              alerts_enabled = ?, alert_email = ?, alert_on = ?, alert_min_drop_pct = ?,
              -- Turning alerts ON re-decides the baseline. A route that has been
              -- dark has a stale per-source snapshot, so its next diff would call
              -- everything new and email a wall of it; clearing the digest clock
              -- makes the next sweep a silent baseline. But a route somebody
              -- searched RECENTLY already holds the snapshot a baseline sweep
              -- would go and fetch, so baselineOnEnable stamps the clock instead
              -- and the very next sweep can email real changes. See its docblock —
              -- the baseline is the snapshot, this column is only the suppression.
              -- (No backticks in here — this is a template literal.)
              alert_last_digest_at = CASE WHEN ? = 1 AND alerts_enabled = 0
                                          THEN ? ELSE alert_last_digest_at END,
              -- A settings change is a fresh start for the back-off too; otherwise
              -- fixing a broken window would still wait out the old penalty.
              alert_consecutive_failures = 0
        WHERE id = ?`,
    )
    .bind(
      v.origin,
      v.destination,
      v.origins,
      v.destinations,
      v.via,
      v.dateStart,
      v.dateEnd,
      v.cabin,
      v.cabins,
      v.currencies,
      v.minSeats,
      v.directOnly,
      v.pointLimit,
      v.roundTrip,
      v.alertsEnabled,
      v.alertEmail,
      v.alertOn,
      v.alertMinDropPct,
      v.alertsEnabled,
      v.baselineDigestAt,
      id,
    )
    .run();
}

export async function deleteTrackedRoute(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM tracked_routes WHERE id = ?").bind(id).run();
}

/** The airport sets and direction of one route — what the hub suggestion needs. */
export async function selectRouteShape(
  db: D1Database,
  id: number,
): Promise<Record<string, unknown> | null> {
  return await db
    .prepare(
      `SELECT origin, destination, origins, destinations, round_trip
         FROM tracked_routes WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
}

/**
 * The Routes page's routes.
 *
 * THE COLUMN LIST IS LOAD-BEARING, and an explicit list is exactly the kind that
 * gets forgotten when a schema change adds one. The route-SET columns are what
 * the page draws a route's shape from: omitting them doesn't fail, it silently
 * renders every multi-airport route as a plain single-pair route.
 *
 * Since the header edits the route in place, this list is ALSO what the edit form
 * is seeded from — every settable column has to be here or its field opens
 * showing a default the row does not hold. PATCH merges against the stored row,
 * so the damage stops at the form; but a switch that renders "off" for a route
 * that is on is its own bug. The alert columns are exactly the case that warning
 * was written about, and they were missing from it: the edit dialog sends
 * `alertsEnabled` on every save rather than omitting it, so a form seeded from an
 * absent column sent `false` and QUIETLY UNENROLLED the route.
 *
 * The last three are state rather than settings, and are here because the Routes
 * page draws a route's alert health beside it (see app/src/lib/alerts.ts).
 *
 * The route-set and date columns the read scope needs are already in this list,
 * so scoping the page's finds adds no columns.
 */
export async function selectRoutesForPage(
  db: D1Database,
): Promise<(TrackedRoute & ScopedRoute)[]> {
  const { results } = await db
    .prepare(
      "SELECT id, origin, destination, origins, destinations, via," +
        " date_start, date_end, cabins, currencies, min_seats, direct_only, point_limit," +
        " round_trip," +
        " last_checked_at," +
        " alerts_enabled, alert_email, alert_on, alert_min_drop_pct," +
        " alert_last_attempt_at, alert_last_digest_at, alert_consecutive_failures" +
        " FROM tracked_routes ORDER BY created_at DESC",
    )
    .all<TrackedRoute & ScopedRoute>();
  return results ?? [];
}

/** Every route's REACH — its airports, window and direction, and nothing else.
 *  What `withinRouteScope` authorizes a coordinate-named find against. */
export async function selectScopedRoutes(db: D1Database): Promise<ScopedRoute[]> {
  const { results } = await db
    .prepare(
      `SELECT origin, destination, origins, destinations, via, date_start, date_end, round_trip
         FROM tracked_routes`,
    )
    .all<ScopedRoute>();
  return results ?? [];
}

export interface RouteWindowRow {
  id: number;
  origin: string;
  destination: string;
  date_start: string;
  date_end: string;
}

/** One route's primary pair and window — what a bulk enrich sweeps over. */
export async function selectRouteWindow(
  db: D1Database,
  id: number,
): Promise<RouteWindowRow | null> {
  return await db
    .prepare("SELECT id, origin, destination, date_start, date_end FROM tracked_routes WHERE id = ?")
    .bind(id)
    .first<RouteWindowRow>();
}

export interface ReachRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  round_trip: number;
  programs: string | null;
}

/** Every route, for the reach report. */
export async function selectRoutesForReach(db: D1Database): Promise<ReachRouteRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, origin, destination, origins, destinations, round_trip
         FROM tracked_routes
        ORDER BY id`,
    )
    .all<ReachRouteRow>();
  return results ?? [];
}

/** How many routes send their digest to this address. Read before deleting a
 *  recipient: a route pointing at a removed address does not fail loudly — its
 *  digest is recorded `skipped` forever and nothing announces it. */
export async function countRoutesUsingRecipient(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tracked_routes WHERE lower(trim(alert_email)) = ?")
    .bind(email)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ---- what a search reads and writes ---------------------------------------

export interface SearchRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  date_start: string;
  date_end: string;
  /** 1 = search BOTH directions. Unlike every other per-route flag this one
   *  changes what is gathered, not what is shown. */
  round_trip: number;
  /** JSON array of hub IATA codes, or null. The OTHER gathering setting, and
   *  the only one that changes what a search COSTS: hubs are separate markets,
   *  so they plan a second query per date chunk. Ignored on a round trip. */
  via: string | null;
}

export async function selectSearchRoute(
  db: D1Database,
  id: number,
): Promise<SearchRouteRow | null> {
  return await db
    .prepare(
      `SELECT id, origin, destination, origins, destinations, date_start, date_end,
              round_trip, via
         FROM tracked_routes WHERE id = ?`,
    )
    .bind(id)
    .first<SearchRouteRow>();
}

/** The coverage clock. Only a run that actually claimed coverage may stamp it,
 *  which is the caller's test, not this one's: a wholly-failed search leaves it
 *  alone so the route keeps reading as never searched — which is the truth. */
export async function stampLastChecked(db: D1Database, id: number, at: number): Promise<void> {
  await db
    .prepare("UPDATE tracked_routes SET last_checked_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
}

// ---- what the sweep reads and writes --------------------------------------

export interface AlertRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  date_start: string;
  date_end: string;
  cabins: string | null;
  /** Read by `routeMatcher`, and absent from this row until the match moved out
   *  of SQL. While the predicate was a join against `tracked_routes tr` these
   *  two came off `tr` and nothing here had to carry them; a matcher fed a row
   *  without them silently reads "no currency filter, connections allowed" and
   *  fires alerts on finds the route's own pane hides. */
  currencies: string | null;
  direct_only: number;
  min_seats: number;
  /** The route's points ceiling, or null. Read for the `gone` branch of
   *  `selectAlertable`, and by `routeMatcher` for every other change type. */
  point_limit: number | null;
  round_trip: number;
  /** Hubs, which double the queries per chunk — see `routeSweepCost`. */
  via: string | null;
  alert_email: string | null;
  alert_on: string | null;
  alert_min_drop_pct: number;
  alert_last_attempt_at: number | null;
  alert_last_digest_at: number | null;
  alert_consecutive_failures: number;
  last_checked_at: number | null;
  /** What this route's last completed sweep actually spent. */
  observed_calls: number | null;
}

/**
 * Every alert-enabled route, with the two things pacing needs alongside it: how
 * long since it was attempted, and what its last completed sweep actually spent.
 *
 * `observed_calls` is read off `runs.calls` for THIS route by `route_id` — the
 * `origin`/`destination` scalars are only the route's primary airports, so two
 * routes sharing a pair would otherwise be priced off each other's measurements.
 */
export async function selectAlertRoutes(db: D1Database): Promise<AlertRouteRow[]> {
  const { results } = await db
    .prepare(
      `SELECT tr.id, tr.origin, tr.destination, tr.origins, tr.destinations,
              tr.date_start, tr.date_end, tr.cabins, tr.currencies, tr.direct_only,
              tr.min_seats, tr.point_limit,
              tr.round_trip,
              tr.via,
              tr.alert_email, tr.alert_on, tr.alert_min_drop_pct,
              tr.alert_last_attempt_at, tr.alert_last_digest_at,
              tr.alert_consecutive_failures, tr.last_checked_at,
              (SELECT hr.calls FROM runs hr
                WHERE hr.route_id = tr.id AND hr.trigger = 'alert'
                  AND hr.finished_at IS NOT NULL
                ORDER BY hr.started_at DESC LIMIT 1) AS observed_calls
         FROM tracked_routes tr
        WHERE tr.alerts_enabled = 1
        ORDER BY tr.id`,
    )
    .all<AlertRouteRow>();
  return results ?? [];
}

/** Routes swept this cycle with nothing to say. They are NAMED in the digest
 *  rather than omitted — "three checked, two quiet" and "only one ran" are
 *  different facts and no failure email exists to tell them apart. */
export async function selectQuietAlertRoutes(db: D1Database): Promise<AlertRouteRow[]> {
  const { results } = await db
    .prepare(
      `SELECT tr.* FROM tracked_routes tr
        WHERE tr.alerts_enabled = 1
          AND tr.alert_last_digest_at IS NOT NULL
          AND tr.id NOT IN (SELECT route_id FROM alert_outbox)`,
    )
    .all<AlertRouteRow>();
  return results ?? [];
}

/** The PACING clock, stamped on every ATTEMPT before anything can fail. Stamping
 *  it only on success would let a permanently-failing route be due on every
 *  single tick and spend the day rediscovering the same failure. */
export async function stampAlertAttempt(db: D1Database, id: number, at: number): Promise<void> {
  await db
    .prepare("UPDATE tracked_routes SET alert_last_attempt_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
}

/** The EMAIL clock. NULL suppresses — a route with no digest yet performs a
 *  silent baseline sweep first. */
export async function stampAlertDigest(db: D1Database, id: number, at: number): Promise<void> {
  await db
    .prepare("UPDATE tracked_routes SET alert_last_digest_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
}

/** Stamp the email clock for everything one successful send covered. */
export async function stampAlertDigestForRoutes(
  db: D1Database,
  ids: readonly number[],
  at: number,
): Promise<void> {
  if (!ids.length) return;
  await db
    .prepare(
      `UPDATE tracked_routes SET alert_last_digest_at = ?
        WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(at, ...ids)
    .run();
}

export async function bumpAlertFailures(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      "UPDATE tracked_routes SET alert_consecutive_failures = alert_consecutive_failures + 1 WHERE id = ?",
    )
    .bind(id)
    .run();
}

export async function clearAlertFailures(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE tracked_routes SET alert_consecutive_failures = 0 WHERE id = ?")
    .bind(id)
    .run();
}
