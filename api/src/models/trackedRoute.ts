/**
 * A TRACKED ROUTE — the saved search everything else hangs off, in the several
 * shapes the Worker holds it in.
 *
 * There are two kinds of type here and the difference matters.
 *
 * **Writes** (`NewTrackedRoute`, `EditedTrackedRoute`) are what the handler has
 * already decided: every value is validated, normalized and clamped before it
 * reaches one, so `db/trackedRoutes.ts` only binds them.
 *
 * **Projections** (`ScopedRoute`, `SearchRouteRow`, `AlertRouteRow`,
 * `ReachRouteRow`, `RouteWindowRow`) are what one SELECT returns, and they are
 * deliberately NOT interchangeable: five surfaces read this table and each needs
 * a different column list. Keeping one type per projection is what stops a row
 * fetched for one purpose being handed to code expecting another — a matcher fed
 * a row without `currencies` silently reads "no currency filter" and fires
 * alerts on finds the route's own pane hides. Each type names the function that
 * produces it, in `db/trackedRoutes.ts`, and the two are edited together.
 *
 * The row the SPA renders is `TrackedRoute`, a WIRE type
 * (`shared/src/wire/rows.ts`). Nothing in this file is rendered.
 */

/** A route as it is written on create. Every value here has already been
 *  validated, normalized and clamped by the caller. Bound by
 *  `insertTrackedRoute`. */
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

/** A route as it is written on edit: the whole row, already merged. Bound by
 *  `updateTrackedRoute`. */
export interface EditedTrackedRoute extends NewTrackedRoute {
  /** What `alert_last_digest_at` becomes IF alerts are turning ON. Only consulted
   *  by the CASE inside the statement, i.e. only on an OFF -> ON transition. */
  baselineDigestAt: number | null;
}

/** The `tracked_routes` columns a read scope is derived from — a subset of what
 *  `MatchableRoute` reads. Structurally satisfied by `AlertRouteRow` and by the
 *  Routes page's route SELECT, so neither caller needs an extra query. */
export interface ScopedRoute {
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  via: string | null;
  date_start: string;
  date_end: string;
  round_trip: number;
}

/**
 * The route's READ FILTERS — what it shows out of what was gathered.
 *
 * Separate from `ScopedRoute`, and every field optional, because the two answer
 * different questions and only one of them may be pushed down. `ScopedRoute`
 * says where a route REACHES, and `withinRouteScope` authorizes against it: it
 * must never see a filter, or a points ceiling would start returning 404 on a
 * row the Routes page is displaying.
 *
 * Optional because omitting one only ever WIDENS. Wrong in the cheap direction.
 *
 * `currencies` is deliberately absent; `pushFilters` in `db/finds.ts` says why.
 */
export interface RouteFilters {
  cabins?: string | null;
  min_seats?: number;
  direct_only?: number;
  point_limit?: number | null;
}

/** What `routeFindsScope` reads. */
export type FilteredRoute = ScopedRoute & RouteFilters;

/** One route's primary pair and window — what a bulk enrich sweeps over.
 *  Produced by `selectRouteWindow`. */
export interface RouteWindowRow {
  id: number;
  origin: string;
  destination: string;
  date_start: string;
  date_end: string;
}

/** Every route's airports and direction, for the reach report. Produced by
 *  `selectRoutesForReach`. */
export interface ReachRouteRow {
  id: number;
  origin: string;
  destination: string;
  origins: string | null;
  destinations: string | null;
  round_trip: number;
  programs: string | null;
}

/** What the search planner needs off a route. Produced by `selectSearchRoute`. */
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

/** An alert-enabled route with its three clocks and its measured cost. Produced
 *  by `selectAlertRoutes`, which is where `observed_calls` comes from. */
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
