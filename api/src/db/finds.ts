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

/** Columns projected out of the collapsed set — callers must not reach past
 *  this list. */
export const FIND_COLUMNS = `f.origin, f.destination, f.flight_date, f.route_key,
       f.program, f.cabin, f.seats_available, f.miles_cost, f.cash_fees_cents,
       f.fees_currency, f.is_direct, f.segments_json, f.source, f.source_fetched_at,
       f.captured_at, f.transfer_currencies, f.duration_minutes,
       f.booking_url, f.search_run_id,
       f.detail_level, f.enriched_at, f.source_record_id,
       f.stop_count, f.airlines, f.direct_airlines, f.direct_miles_cost,
       f.best_miles_ever`;

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
 * Column names go in UNQUALIFIED. The text is interpolated twice — into the
 * inner grouping subquery, where the table is bare, and into the outer join,
 * where it is aliased `s`. Neither is ambiguous, because `latest` projects only
 * route_key/program/cabin/source/mx. (`route_key` itself WOULD be ambiguous in
 * the outer position, which is a second reason the rule above is the rule.)
 */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/** No narrowing — the whole table enters the collapse. What both callers used
 *  to pass, and what `routeFindsScope` falls back to when a route set is too
 *  wide to describe inside D1's bind limit. Slow and right. */
const UNSCOPED: FindsScope = { where: [], binds: [] };

/** The `tracked_routes` columns a scope is derived from — the same ones
 *  `ROUTE_FINDS_MATCH` reads off `tr`. Structurally satisfied by
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
 * D1 allows **100 bound parameters per query**. `scope.binds` is consumed TWICE
 * (see `findsCte`), and every caller appends two binds of its own, so the
 * ceiling on a scope is `(100 - 2) / 2 = 49`. 45 leaves a little room for a
 * caller that grows a third bind.
 */
const MAX_SCOPE_BINDS = 45;

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
 * every find `ROUTE_FINDS_MATCH` could accept for any of them.
 *
 * It lives here, beside the predicate it is a claim about, because the two have
 * to be read together. **A branch added to `ROUTE_FINDS_MATCH` without a
 * matching widening here silently drops finds** — out of the Routes page, and out
 * of alert digests, which send no mail when they find nothing and so cannot
 * tell you.
 *
 * The proof, branch by branch. Let `O` be the origin set built below, `D` the
 * destination set, and `[lo, hi]` the date range. For a find `f` that
 * `ROUTE_FINDS_MATCH` accepts under route `tr`:
 *
 * | branch | requires | covered because |
 * | --- | --- | --- |
 * | forward | `f.origin ∈ origins`, `f.destination ∈ destinations`, date in `[date_start, date_end]` | `origins ⊆ O`, `destinations ⊆ D`, and `[date_start, date_end] ⊆ [lo, hi]` |
 * | round trip | `f.origin ∈ destinations`, `f.destination ∈ origins`, same dates | the `round_trip` clause adds `destinations → O` and `origins → D` |
 * | first hub leg | `f.origin ∈ origins`, `f.destination ∈ via` | `origins ⊆ O`; the hub loop adds `via → D` |
 * | second hub leg | `f.origin ∈ via`, `f.destination ∈ destinations`, date in `[date_start, date_end + 1 day]` | the hub loop adds `via → O`; `destinations ⊆ D`; `hi` is widened by a day |
 *
 * Everything else in `ROUTE_FINDS_MATCH` — cabins, currencies, `direct_only`,
 * `point_limit` — and `ROUTE_FINDS_SEATS` only narrow further, so none of them
 * can admit a find this scope excludes.
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
 * at `MAX_ORIGINS`/`MAX_DESTINATIONS`/`MAX_VIA` of three that is 36 pairs, 72
 * binds, **144 after the double consumption** — against a hard limit of 100, for
 * a route shape the UI will happily let you build. The sets below are O(n):
 * nine a side worst case, twenty binds, forty doubled.
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
 * Build the `finds` CTE.
 *
 * Two steps:
 *
 *  1. `per_source` — the latest row per (route_key, program, cabin, **source**).
 *  2. `finds` — one row per (route_key, program, cabin), the freshest
 *     `source_fetched_at` winning.
 *
 * The bare-column-with-MAX in step 2 is SQLite-specific and deliberate: it
 * returns the whole row that produced the max, which is exactly the winner.
 *
 * `scope.binds` are consumed TWICE (the inner grouping and the outer filter
 * both apply it), so callers append their own binds only after `binds` below.
 */
export function findsCte(scope: FindsScope): { sql: string; binds: unknown[] } {
  const where = scope.where.length ? `WHERE ${scope.where.join(" AND ")}` : "";
  const sql = `
WITH per_source AS (
  SELECT s.*
    FROM availability_snapshots s
    JOIN (
      SELECT route_key, program, cabin, source, MAX(captured_at) AS mx
        FROM availability_snapshots
        ${where}
       GROUP BY route_key, program, cabin, source
    ) latest
      ON latest.route_key = s.route_key AND latest.program = s.program
     AND latest.cabin = s.cabin AND latest.source = s.source
     AND latest.mx = s.captured_at
    ${where}
),
-- MATERIALIZED, and it is worth 2.5x on its own.
--
-- The Routes page joins this CTE to tracked_routes through ROUTE_FINDS_MATCH,
-- which is all json_each — no index can serve it, so the plan is a nested loop
-- with SCAN tr outside and SCAN f inside. This CTE is referenced ONCE, so
-- SQLite defaults to a co-routine, and a co-routine as the inner loop is
-- RESTARTED per outer row: the whole pipeline above — both scans of
-- availability_snapshots, the automatic index on latest, both GROUP BY temp
-- b-trees, and every price_history seek — re-ran once per tracked route.
--
-- Measured on production, six routes over 11,687 snapshots: 284,399 rows read
-- and 276ms, against 115,507 and 78ms with this keyword. The cost scaled with
-- the route COUNT, so adding a seventh route that gathered nothing still made
-- every Routes page load dearer. (No backticks in here — this is a template
-- literal.)
finds AS MATERIALIZED (
  SELECT p.origin, p.destination, p.flight_date, p.route_key, p.program, p.cabin,
         p.seats_available, p.miles_cost, p.cash_fees_cents, p.fees_currency,
         p.is_direct, p.segments_json, p.source, p.source_fetched_at, p.captured_at,
         p.transfer_currencies, p.duration_minutes, p.booking_url,
         p.search_run_id,
         -- Whether this find describes a real aeroplane, and the handle to buy
         -- that if it does not. Attributes of the WINNING row: an itinerary
         -- belongs to the source that claimed it, so one source's legs must
         -- never be attributed to another source's row.
         p.detail_level, p.enriched_at, p.source_record_id,
         -- Same rule as detail_level above: these describe the WINNING row's
         -- own claim about which aeroplanes serve this slot.
         p.stop_count, p.airlines, p.direct_airlines, p.direct_miles_cost,
         -- The cheapest this slot has EVER been seen at, as a correlated seek.
         -- Across sources on purpose: "the best anyone ever saw" is not a
         -- claim about who saw it, unlike detail_level and the carrier lists
         -- above.
         --
         -- Safe against the bare-column rule this SELECT relies on: all three
         -- correlated columns ARE the group key, so the value is constant
         -- within the group by construction, and it cannot matter which row of
         -- the group SQLite evaluates this on.
         --
         -- Adds NO BIND, which is what keeps findsCte's binds exactly
         -- [...scope.binds, ...scope.binds] and every caller's .bind() line
         -- unchanged.
         --
         -- Wants idx_ph_best (migration 0009) to be one row per seek: three
         -- equality terms and MIN() on the trailing column, with the NULLs of
         -- gone-points excluded by the index's own WHERE so MIN never scans
         -- past them.
         --
         -- THE IS NOT NULL IS LOAD-BEARING AND IS NOT A NO-OP TO THE PLANNER.
         -- MIN() already ignores NULLs, so it changes no result — but idx_ph_best
         -- is PARTIAL, and SQLite will only use a partial index when the query's
         -- own WHERE implies the index's. Without this line it measured
         -- "SEARCH ph USING INDEX idx_ph_slot": the wrong index, not covering,
         -- and a row fetch per seek. Deleting it as redundant silently doubles
         -- the cost of the app's most expensive query.
         --
         -- NULL is a real answer — a snapshot written before 0009's backfill
         -- has no history row — and reads as "no cheapest known".
         (SELECT MIN(ph.miles_cost)
            FROM price_history ph
           WHERE ph.route_key = p.route_key
             AND ph.program = p.program
             AND ph.cabin = p.cabin
             AND ph.miles_cost IS NOT NULL) AS best_miles_ever,
         MAX(p.source_fetched_at) AS _winner
    FROM per_source p
   GROUP BY p.route_key, p.program, p.cabin
)`;
  return { sql, binds: [...scope.binds, ...scope.binds] };
}

/**
 * "Does this find belong to this tracked route, and does it pass the route's own
 * filters?" — as a correlated predicate over `finds f` and `tracked_routes tr`.
 *
 * This one is a shared constant because the Routes page join and the alert sweep
 * are asking exactly the same question — *what would this route show me?* — and
 * an alert that fired on a find the route's own pane hides would be
 * indistinguishable from a bug in either half.
 *
 * A correlated fragment rather than a bind-list builder because the Routes page
 * joins the whole table and the sweep joins one row of it; sharing the SQL text
 * keeps them literally identical, where two builders would only look it.
 *
 * The caller supplies the join (`tr`), the CTE (`f`), and `WHERE`
 * `ROUTE_FINDS_SEATS`. **No binds.**
 */
export const ROUTE_FINDS_MATCH = `(
        -- MEMBERSHIP, not equality: a route is a SET of airports per side, so
        -- a PDX find belongs to a SEA/PDX route and must not appear under a
        -- SEA-only one. COALESCE lets a row carrying only the scalar work off
        -- it. Same json_each idiom as the cabins and currencies clauses below.
        --
        -- A ROUND-TRIP route matches the REVERSED sides too, and must: its
        -- search deliberately gathered HND->SEA alongside SEA->HND (one call,
        -- see roundTripSpec), so without the second branch those return legs
        -- would be stored, claimed as covered, and invisible — the exact
        -- "looks like no award space" failure the app is built to avoid.
        --
        -- A route with HUBS matches its legs too, and the date test is per
        -- branch rather than shared because the second leg's is different. Its
        -- search gathered SFO->ICN and ICN->KTM alongside SFO->KTM (two calls,
        -- see planRoute), so without these branches the legs would be stored,
        -- claimed as covered, and invisible — the same failure the round-trip
        -- branch above exists to prevent. They surface as JOURNEYS rather than as
        -- rows of their own; RoutesPage is what splits them.
        (
          (
            ((EXISTS (
               SELECT 1 FROM json_each(COALESCE(tr.origins, json_array(tr.origin))) ro
                WHERE ro.value = f.origin
             )
             AND EXISTS (
               SELECT 1 FROM json_each(COALESCE(tr.destinations, json_array(tr.destination))) rd
                WHERE rd.value = f.destination
             ))
            OR
            (tr.round_trip = 1
             AND EXISTS (
               SELECT 1 FROM json_each(COALESCE(tr.destinations, json_array(tr.destination))) rd
                WHERE rd.value = f.origin
             )
             AND EXISTS (
               SELECT 1 FROM json_each(COALESCE(tr.origins, json_array(tr.origin))) ro
                WHERE ro.value = f.destination
             )))
            AND f.flight_date BETWEEN tr.date_start AND tr.date_end
          )
          OR
          -- First leg: an origin to a hub, inside the window like any other.
          (tr.via IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(COALESCE(tr.origins, json_array(tr.origin))) ro
              WHERE ro.value = f.origin
           )
           AND EXISTS (SELECT 1 FROM json_each(tr.via) rv WHERE rv.value = f.destination)
           AND f.flight_date BETWEEN tr.date_start AND tr.date_end)
          OR
          -- Second leg: a hub to a destination, and it may depart the day AFTER
          -- the window closes. An overnight in the hub on the last gathered date
          -- is a real journey, and the shared window test would clip exactly it.
          -- The one day mirrors DEFAULT_MAX_CONNECT_DAYS in lib/multiLeg.ts,
          -- which is what decides whether the pair actually joins; widening one
          -- without the other only ever wastes rows.
          (tr.via IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(tr.via) rv WHERE rv.value = f.origin)
           AND EXISTS (
             SELECT 1 FROM json_each(COALESCE(tr.destinations, json_array(tr.destination))) rd
              WHERE rd.value = f.destination
           )
           AND f.flight_date BETWEEN tr.date_start AND date(tr.date_end, '+1 day'))
        )
        -- Honor the route's cabin filter (NULL = any cabin), matching the
        -- snapshot's scalar cabin against the route's JSON cabin array.
        AND (tr.cabins IS NULL
             OR EXISTS (
               SELECT 1 FROM json_each(tr.cabins) rc WHERE rc.value = f.cabin
             ))
        -- Honor the route's currency filter: a snapshot only surfaces under a
        -- filtered route when its bookable currencies intersect the filter.
        -- Snapshots are shared across routes matched by origin/destination/
        -- date, so this join condition (not the gather) enforces it per-route.
        AND (tr.currencies IS NULL
             OR EXISTS (
               SELECT 1
                 FROM json_each(tr.currencies) rc
                 JOIN json_each(f.transfer_currencies) tc ON tc.value = rc.value
             ))
        -- Nonstop-only, when the route asks for it. A READ filter and nothing
        -- more: the connecting itineraries it hides are still stored and still
        -- claim coverage, so switching this off shows them again with no
        -- re-search. Same rule the cabin filter follows: gather wide, query
        -- narrow. (No backticks in here — this is a template literal.)
        AND (tr.direct_only = 0 OR f.is_direct = 1)
        -- The route's points ceiling, when it has one. A READ filter on the same
        -- footing as the cabin and nonstop clauses: the dearer awards it hides
        -- are still stored and still claim coverage, so raising the cap shows
        -- them again with no re-search.
        --
        -- Compared against miles_cost, which quotes the CHEAPEST itinerary of
        -- any shape for this (route, date, program, cabin) — not
        -- direct_miles_cost, which is what the nonstop costs when a dearer one
        -- exists. A route capped at 100k with nonstop-only on can therefore show
        -- a row whose nonstop price is above the cap; that is the same "the cap
        -- is about the find" reading everywhere else, and direct_only narrowing
        -- WHICH itineraries exist is a separate question from what they cost.
        -- (No backticks in here — this is a template literal.)
        AND (tr.point_limit IS NULL OR f.miles_cost <= tr.point_limit)
      )`;

/** The route's seat floor. Separate from `ROUTE_FINDS_MATCH` only because the
 *  Routes page has always applied it in `WHERE` rather than in the join, and this
 *  extraction changes no SQL. */
export const ROUTE_FINDS_SEATS = `f.seats_available >= tr.min_seats`;

