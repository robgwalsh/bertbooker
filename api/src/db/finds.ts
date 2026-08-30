import { addDaysISO } from "../providers/window.js";

/**
 * The read side of the pivot.
 *
 * `availability_snapshots` is now current **per source**: gathering is
 * decoupled from querying, so two sources contributing to one
 * (route, date, program, cabin) is the normal case across days rather than a
 * rare collision inside one button press. Nothing merges them before the write
 * any more — both claims stay on the record — so collapsing to one answer is a
 * read-time job, and it has to happen identically everywhere or two surfaces
 * disagree about the same seat.
 *
 * Hence one CTE, built here and used by every reader. There were three readers
 * once — the Routes page, the SPA's database browser, and `GET /api/finds` — and
 * the Routes page is the only one left. The rule survives them, because the next
 * reader added is exactly when a second hand-written collapse would creep back
 * in. The tables it reads are defined in migrations/0001_init.sql.
 */

/**
 * Columns the Routes page projects out of the collapsed set — callers must not
 * reach past this list.
 *
 * Five columns left this list: `route_key`, `source`, `source_fetched_at`,
 * `captured_at` and `search_run_id`. All five crossed the wire and were read by
 * nothing; two of them (`route_key`, `captured_at`) were not even declared on
 * `Find`. `best_miles_ever` is not here either — it is computed, not stored, so
 * a caller that wants it appends BEST_MILES_EVER.
 */
export const FIND_COLUMNS = `f.origin, f.destination, f.flight_date,
       f.program, f.cabin, f.seats_available, f.miles_cost, f.cash_fees_cents,
       f.fees_currency, f.is_direct, f.segments_json,
       f.transfer_currencies, f.duration_minutes, f.booking_url,
       f.detail_level, f.enriched_at, f.source_record_id,
       f.stop_count, f.airlines, f.direct_airlines, f.direct_miles_cost`;

/**
 * A predicate narrowing which snapshot rows enter the collapse at all. Keeping
 * this tight matters: without it every query group-bys the whole table.
 *
 * It went unused by both callers for long enough to become the app's largest
 * expense — `findsCte` was reading **168,280 rows to return 7,468**, on a table
 * of 7,900, and three variants of it were 88% of every row this database read.
 * `routeFindsScope` below is what fills it in.
 *
 * **A scope predicate may constrain `origin`, `destination` and `flight_date`,
 * and nothing else.** Those three *are* `route_key` (`routeKey()`,
 * `domain/types.ts`), and `route_key` is in every group key this CTE uses —
 * `per_source` groups by (route_key, program, cabin, source), `finds` by
 * (route_key, program, cabin). So a predicate that is a function of `route_key`
 * includes or excludes each group **whole**, and can never change which row wins
 * a collapse. A predicate naming `program`, `cabin`, `source`, `captured_at` or
 * `source_fetched_at` can do exactly that, and would look like it worked.
 *
 * Column names go in UNQUALIFIED, and the text is interpolated once, into a
 * grouping query over the bare table.
 */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/** No narrowing — the whole table enters the collapse. What both callers used
 *  to pass, and what `routeFindsScope` falls back to when a route set is too
 *  wide to describe inside D1's bind limit. Slow and right. */
const UNSCOPED: FindsScope = { where: [], binds: [] };

/** The `tracked_routes` columns a scope is derived from — a subset of the ones
 *  `MatchableRoute` reads. Structurally satisfied by
 *  `AlertRouteRow` and by the Routes page's route SELECT, so neither caller needs
 *  an extra query. */
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
 * D1 allows **100 bound parameters per query**. `scope.binds` is consumed ONCE
 * (see `findsCte`), and every caller appends one bind of its own, so the ceiling
 * on a scope is 99. 90 leaves room for a caller that grows more.
 *
 * This was 45 while the scope text was interpolated twice. That halving is what
 * makes the O(n^2) `route_key` prefix-range form discussed below thinkable
 * again — 36 pairs is 72 binds, which now fits. It has NOT been adopted; the
 * O(n) sets below are still what ships.
 */
const MAX_SCOPE_BINDS = 90;

/** `tracked_routes`' JSON list columns, with the scalar fallback the schema's
 *  `COALESCE(tr.origins, json_array(tr.origin))` idiom applies in SQL. Mirrors
 *  `parseList` in `alerts/sweep.ts`, which also parses cabins; kept separate
 *  rather than shared because that one belongs to the sweep's row shape. */
function codeList(json: string | null, fallback?: string): string[] {
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
    } catch {
      /* fall through to the scalar */
    }
  }
  return fallback ? [fallback] : [];
}

/**
 * The `FindsScope` for a set of tracked routes — a **provable superset** of
 * every find `routeMatcher` could accept for any of them.
 *
 * It lives here, beside the predicate it is a claim about, because the two have
 * to be read together, and they now live in different files — this bounds the D1
 * read, `shared/src/match/routeMatch.ts` narrows what comes back. **A branch
 * added there without a matching widening here silently drops finds** — out of the Routes page, and out
 * of alert digests, which send no mail when they find nothing and so cannot
 * tell you.
 *
 * The proof, branch by branch. Let `O` be the origin set built below, `D` the
 * destination set, and `[lo, hi]` the date range. For a find `f` that
 * `routeMatcher` accepts under route `tr`:
 *
 * | branch | requires | covered because |
 * | --- | --- | --- |
 * | forward | `f.origin ∈ origins`, `f.destination ∈ destinations`, date in `[date_start, date_end]` | `origins ⊆ O`, `destinations ⊆ D`, and `[date_start, date_end] ⊆ [lo, hi]` |
 * | round trip | `f.origin ∈ destinations`, `f.destination ∈ origins`, same dates | the `round_trip` clause adds `destinations → O` and `origins → D` |
 * | first hub leg | `f.origin ∈ origins`, `f.destination ∈ via` | `origins ⊆ O`; the hub loop adds `via → D` |
 * | second hub leg | `f.origin ∈ via`, `f.destination ∈ destinations`, date in `[date_start, date_end + 1 day]` | the hub loop adds `via → O`; `destinations ⊆ D`; `hi` is widened by a day |
 *
 * Everything else the matcher applies — cabins, currencies, `direct_only`,
 * `point_limit`, `min_seats` — only narrows further, so none of them can admit a
 * find this scope excludes.
 *
 * The `+1 day` is applied to EVERY route rather than only to hub routes. It is
 * trivially still a superset, it costs at most one extra day of rows, and it
 * removes a conditional that would otherwise have to be kept in step with the
 * second-leg branch — the one case where an overnight in the hub on the last
 * gathered date is a real journey.
 *
 * **Why `IN` lists and not `route_key` prefix ranges.** A range per
 * (origin, destination) pair reads beautifully — `route_key` already leads two
 * indexes, and one route measured 82 rows read against 171,471. But the pair
 * set is `(origins × destinations) ∪ (destinations × origins) ∪
 * (origins × via) ∪ (via × destinations)`, which is O(n²) in the route's width:
 * at `MAX_ORIGINS`/`MAX_DESTINATIONS`/`MAX_VIA` of three that is 36 pairs and 72
 * binds, for a route shape the UI will happily let you build. That fitted in no
 * budget at all while the scope was consumed twice, and fits the 100-bind limit
 * now that it is consumed once — but O(n^2) in a width the UI controls is still
 * the wrong shape to bet a page load on. The sets below are O(n): nine a side
 * worst case, twenty binds.
 */
export function routeFindsScope(routes: readonly ScopedRoute[]): FindsScope {
  const sets = scopeSets(routes);
  if (!sets) return UNSCOPED;

  const o = [...sets.origins];
  const d = [...sets.destinations];
  if (o.length + d.length + 2 > MAX_SCOPE_BINDS) return UNSCOPED;

  return {
    where: [
      `origin IN (${o.map(() => "?").join(", ")})`,
      `destination IN (${d.map(() => "?").join(", ")})`,
      `flight_date BETWEEN ? AND ?`,
    ],
    binds: [...o, ...d, sets.lo, sets.hi],
  };
}

/**
 * The origin set, destination set and date range a set of routes can produce
 * finds across — the whole of what the docblock above works through, with the
 * SQL peeled off.
 *
 * Extracted so `routeFindsScope` and `withinRouteScope` below cannot drift.
 * Those two ask the same question in opposite directions — "which finds might
 * these routes have?" and "might these routes have this find?" — and the second
 * is an AUTHORIZATION check. Built on its own hand-copied idea of what a route
 * covers, it would start refusing legitimate hub legs the first time either the
 * `via` handling or the `round_trip` handling moved, and it would do it as a
 * 404 on a button that used to work.
 *
 * `null` rather than a pair of empty sets, because the two callers must answer a
 * degenerate input differently: no usable routes means "read everything" to one
 * and "permit nothing" to the other.
 */
function scopeSets(routes: readonly ScopedRoute[]): {
  origins: Set<string>;
  destinations: Set<string>;
  lo: string;
  hi: string;
} | null {
  const origins = new Set<string>();
  const destinations = new Set<string>();
  let lo: string | undefined;
  let hi: string | undefined;

  for (const r of routes) {
    const o = codeList(r.origins, r.origin);
    const d = codeList(r.destinations, r.destination);
    const via = codeList(r.via);
    // Can't happen — the scalars are NOT NULL — but an empty side would make
    // `origin IN ()` a syntax error, and unscoped is the safe direction.
    if (!o.length || !d.length) return null;

    for (const x of o) origins.add(x);
    for (const x of d) destinations.add(x);
    if (r.round_trip === 1) {
      for (const x of d) origins.add(x);
      for (const x of o) destinations.add(x);
    }
    // A hub is reachable as either side: origins → hub is the first leg, hub →
    // destinations the second.
    for (const x of via) {
      origins.add(x);
      destinations.add(x);
    }

    if (lo === undefined || r.date_start < lo) lo = r.date_start;
    const end = addDaysISO(r.date_end, 1);
    if (hi === undefined || end > hi) hi = end;
  }
  if (lo === undefined || hi === undefined) return null;

  return { origins, destinations, lo, hi };
}

/**
 * Could this (origin, destination, flight_date) be a find of one of these
 * routes?
 *
 * The authorization question behind `POST /api/finds/enrich`, which is the one
 * endpoint that names an availability row by its COORDINATES rather than by a
 * route id — and then spends a metered seats.aero call on it and writes back to
 * the row. Without this it would enrich anything in the database, including
 * rows no route of the caller's has ever asked about, which made it the
 * cheapest way to burn the day's Partner-API quota.
 *
 * Uses the same superset the read path uses, so it errs GENEROUS: a find this
 * accepts is one the Routes page might legitimately be showing, hub legs and
 * round-trip reversals included. That is the right direction for a check whose
 * false negative is a working button that starts returning 404.
 */
export function withinRouteScope(
  routes: readonly ScopedRoute[],
  origin: string,
  destination: string,
  flightDate: string,
): boolean {
  const sets = scopeSets(routes);
  if (!sets) return false;
  return (
    sets.origins.has(origin) &&
    sets.destinations.has(destination) &&
    flightDate >= sets.lo &&
    flightDate <= sets.hi
  );
}

/**
 * The FROM and WHERE every read of a stored find shares.
 *
 * There is no collapse left to do. `availability_snapshots` holds one row per
 * (route_key, program, cabin) — UNIQUE since 0014 — so a find IS a row, and this
 * is a range seek on `idx_snap_route_date` and nothing else.
 *
 * It was a two-stage CTE until then: `per_source` took MAX(captured_at) per
 * (slot, source) and `finds` took MAX(source_fetched_at) per slot, because the
 * table was append-on-change history and "current" meant "the newest of several
 * rows". Both stages survived the history being deleted as no-op GROUP BYs over
 * groups of one, still paying a temp b-tree each: measured at 35,363 rows read
 * against 9,044 stored, for 7,049 finds. Removing them is the last of it.
 *
 * The alias is `f` because that is what FIND_COLUMNS and every caller name.
 */
export function findsFrom(scope: FindsScope): { sql: string; binds: unknown[] } {
  const where = scope.where.length ? `WHERE ${scope.where.join(" AND ")}` : "";
  return { sql: `FROM availability_snapshots f ${where}`, binds: [...scope.binds] };
}

/**
 * The cheapest this slot has EVER been seen at, as a correlated seek into
 * price_history. Costs exactly one row per find — measured, 5,768 rows for 5,768
 * groups — so it is the one thing in the read path that is already optimal.
 *
 * Across sources on purpose: "the best anyone ever saw" is not a claim about who
 * saw it. Adds no bind, which is what keeps every caller's .bind() line the
 * scope's binds and nothing else.
 *
 * THE IS NOT NULL IS LOAD-BEARING AND IS NOT A NO-OP TO THE PLANNER. MIN()
 * already ignores NULLs, so it changes no result — but idx_ph_best is PARTIAL,
 * and SQLite will only use a partial index when the query's own WHERE implies
 * the index's. Without this line it measured "SEARCH ph USING INDEX
 * idx_ph_slot": the wrong index, not covering, and a row fetch per seek.
 * Deleting it as redundant silently doubles the cost of this query.
 *
 * NULL is a real answer — a row written before 0009's backfill has no history —
 * and reads as "no cheapest known". (No backticks in here.)
 */
export const BEST_MILES_EVER = `(SELECT MIN(ph.miles_cost)
            FROM price_history ph
           WHERE ph.route_key = f.route_key
             AND ph.program = f.program
             AND ph.cabin = f.cabin
             AND ph.miles_cost IS NOT NULL) AS best_miles_ever`;
