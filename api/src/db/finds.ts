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
 * A predicate narrowing which snapshot rows the read returns.
 *
 * It went unused by both callers for long enough to become the app's largest
 * expense — `findsCte` was reading **168,280 rows to return 7,468**, on a table
 * of 7,900, and three variants of it were 88% of every row this database read.
 * `routeFindsScope` below is what fills it in.
 *
 * **A scope may constrain any column `routeMatcher` reads.** It was limited to
 * `origin`, `destination` and `flight_date` for as long as a collapse ran
 * underneath it: `per_source` grouped by (route_key, program, cabin, source) and
 * `finds` by (route_key, program, cabin), and only those three are a function of
 * `route_key` (`routeKey()`, `domain/types.ts`), so only those three included or
 * excluded a whole group. A predicate on `program` or `cabin` split a group,
 * changed which row won the collapse, and looked like it worked.
 *
 * `0014` made the table one row per slot and `findsFrom` a bare range seek with
 * no GROUP BY at all. There is no group left to split, and the restriction went
 * with it — leaving the rule that was always the load-bearing one: **the scope
 * must stay a superset of what `routeMatcher` accepts**. A column may be
 * constrained here exactly as hard as the matcher constrains it, never harder.
 *
 * Column names go in UNQUALIFIED, and the text is interpolated once, into a
 * plain SELECT over the bare table.
 */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/** No narrowing — the whole table is read. What both callers used to pass, and
 *  the last rung of `routeFindsScope`'s ladder when a route set cannot be
 *  described inside D1's bind limit at all. Slow and right. */
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
 * The route's READ FILTERS — what it shows out of what was gathered.
 *
 * Separate from `ScopedRoute` and every field optional, because the two answer
 * different questions and only one of them may be pushed down. `ScopedRoute`
 * says where a route REACHES, and `withinRouteScope` authorizes against it: it
 * must never see a filter, or a points ceiling would start returning 404 on a
 * row the Routes page is displaying.
 *
 * Optional because omitting one only ever WIDENS: each builds a conjunct inside
 * one route's disjunct, so a caller that does not select `cabins` reads rows it
 * did not need and still gets every find `routeMatcher` accepts. Wrong in the
 * cheap direction. Pushing down a filter the matcher does NOT apply is the
 * expensive one — it drops finds silently, out of the Routes page and out of
 * digests that send no mail when they find nothing.
 *
 * `currencies` is deliberately absent; `pushFilters` says why.
 */
export interface RouteFilters {
  cabins?: string | null;
  min_seats?: number;
  direct_only?: number;
  point_limit?: number | null;
}

/** What `routeFindsScope` reads. Structurally satisfied by `AlertRouteRow` and
 *  by the Routes page's route SELECT, both of which already carry all nine
 *  columns. */
export type FilteredRoute = ScopedRoute & RouteFilters;

/**
 * D1 allows **100 bound parameters per query**. `scope.binds` is consumed ONCE
 * (see `findsFrom`), and every caller appends one bind of its own, so the ceiling
 * on a scope is 99. 90 leaves room for a caller that grows more.
 *
 * This is the budget the per-route form is measured against, and the reason
 * there is a union form to fall back to at all: per-route is O(routes x route
 * width) in binds where the union is O(total width), so a wide enough set of
 * routes runs out and has to buy correctness back with rows.
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
 * **The shape is one OR-group per route**, each carrying that route's own
 * airports, window and read filters. It is a ladder, and every rung is correct —
 * they differ only in how many rows they make the database touch:
 *
 *  1. **per route.** The tight one. A find is read only if some route could
 *     actually show it.
 *  2. **the union** (`unionScope`), when the per-route form runs out of binds.
 *     One clause over every route's airports and the widest window, filters
 *     dropped.
 *  3. **UNSCOPED**, when even that will not fit. The whole table.
 *
 * The union rung is the whole cost of the cross product it re-introduces: it
 * reads every `PIT->HND` row on behalf of a `PIT->BOS` route, across a range
 * wide enough for both. Measured on production at seven routes: 7,049 rows
 * returned under the union, 1,591 under this, for 842 the page displays.
 *
 * **Rows RETURNED is not rows READ, and the filters only move the first.** The
 * plan is a MULTI-INDEX OR, one `idx_snap_route_date` seek per group, and that
 * index is `(origin, destination, flight_date, program, cabin, source)` — so
 * `cabin`, `seats_available` and `miles_cost` all sit behind a range column and
 * cannot narrow the seek. They stop a row being fetched from the table and being
 * given a `best_miles_ever` seek; they do not stop its index entry being walked.
 * The same seven routes measured 14,216 rows read before and 8,353 after: real,
 * and roughly half of what the returned-row counts suggest.
 *
 * Closing the rest means an index leading `(origin, destination, cabin)`, which
 * has to be a SECOND index rather than a reordering — `ingest/apply.ts` seeks
 * the same one on `(origin, destination, flight_date)` adjacent, and every
 * ingest prune depends on it. Measured ceiling for that trade: 8,353 -> ~4,000
 * read, against an index written on every snapshot upsert. Not taken.
 *
 * The proof, branch by branch, applies to **one route's disjunct**. Let `O` be
 * that route's origin set, `D` its destination set, and `[lo, hi]` its window.
 * For a find `f` that `routeMatcher` accepts under route `tr`:
 *
 * | branch | requires | covered because |
 * | --- | --- | --- |
 * | forward | `f.origin ∈ origins`, `f.destination ∈ destinations`, date in `[date_start, date_end]` | `origins ⊆ O`, `destinations ⊆ D`, and `[date_start, date_end] ⊆ [lo, hi]` |
 * | round trip | `f.origin ∈ destinations`, `f.destination ∈ origins`, same dates | the `round_trip` clause adds `destinations → O` and `origins → D` |
 * | first hub leg | `f.origin ∈ origins`, `f.destination ∈ via` | `origins ⊆ O`; the hub loop adds `via → D` |
 * | second hub leg | `f.origin ∈ via`, `f.destination ∈ destinations`, date in `[date_start, date_end + 1 day]` | the hub loop adds `via → O`; `destinations ⊆ D`; `hi` is widened by a day |
 *
 * The five filters the matcher then applies — cabins, currencies,
 * `direct_only`, `point_limit`, `min_seats` — are conjuncts, so each may be
 * mirrored here without touching that proof: a find failing one is accepted by
 * no branch. Four of them are (`pushFilters`); `currencies` stays in JS.
 *
 * A find matching TWO routes is read once, not twice, because this is a
 * disjunction rather than a join — which is also why the endpoint's tagging loop
 * over routes, not the scope, is what still emits one row per (find, route)
 * pair.
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
 * the wrong shape to bet a page load on, and the per-route form spends that
 * budget once PER ROUTE. The sets below are O(n): nine a side worst case, and a
 * maximal route's whole disjunct is 26 binds including its filters.
 */
export function routeFindsScope(routes: readonly FilteredRoute[]): FindsScope {
  if (!routes.length) return UNSCOPED;

  const disjuncts: string[] = [];
  const binds: unknown[] = [];
  for (const r of routes) {
    const one = routeDisjunct(r);
    if (!one) return unionScope(routes);
    disjuncts.push(one.sql);
    binds.push(...one.binds);
  }
  if (binds.length > MAX_SCOPE_BINDS) return unionScope(routes);

  // One `where` entry, because `findsFrom` joins them with AND and this is a
  // disjunction. Parenthesised even at length one so a conjunct added later
  // cannot bind tighter than the OR.
  return { where: [`(${disjuncts.join(" OR ")})`], binds };
}

/**
 * One route's own clause — its airports, its window, and its read filters.
 *
 * The airport sets are still a cross product WITHIN the route (route 9's
 * `origin IN (PIT, DTW, YYZ, MSP) AND destination IN (HND, DTW, YYZ, MSP)`
 * admits DTW->YYZ, which no branch of the matcher accepts). That is the same
 * looseness the union form has, kept because tightening it means the O(n^2) pair
 * set argued against above. What is NOT loose any more is the cross product
 * ACROSS routes: the union form read every PIT->HND row on behalf of a PIT->BOS
 * route, and over a date range wide enough for both.
 *
 * `null` when the route has no usable airport set, which the caller answers by
 * dropping to the union form rather than by dropping the route — a route missing
 * from a disjunction contributes no rows, and silently losing its finds is the
 * one outcome this file exists to prevent.
 */
function routeDisjunct(r: FilteredRoute): { sql: string; binds: unknown[] } | null {
  const sets = scopeSets([r]);
  if (!sets) return null;

  const o = [...sets.origins];
  const d = [...sets.destinations];
  const parts = [
    `origin IN (${o.map(() => "?").join(", ")})`,
    `destination IN (${d.map(() => "?").join(", ")})`,
    `flight_date BETWEEN ? AND ?`,
  ];
  const binds: unknown[] = [...o, ...d, sets.lo, sets.hi];
  pushFilters(r, parts, binds);
  return { sql: `(${parts.join(" AND ")})`, binds };
}

/**
 * The route's read filters, as SQL, appended in place.
 *
 * Each mirrors one line of `routeMatcher` and may be **omitted but never
 * tightened**. Omission is what every early return below is doing.
 *
 * All four columns are `NOT NULL` in `availability_snapshots` (0001), which is
 * what makes each comparison agree with the matcher's on every stored row. A
 * nullable one would not: SQL reads `NULL <= 100000` as excluded where the
 * matcher's `null > 100000` keeps, so making one of these nullable means adding
 * an `IS NULL OR` here, not just changing the schema.
 *
 * **`currencies` is deliberately not pushed down**, and not because it is
 * unindexable — though `json_each` is. `routeMatch.ts` reads a malformed filter
 * column as "no filter" precisely because blanking the Routes page over one bad
 * column is worse than showing an unfiltered row; `json_each` on malformed JSON
 * raises and fails the whole request, which is the behaviour that file's header
 * records as having been chosen against.
 */
function pushFilters(r: RouteFilters, parts: string[], binds: unknown[]): void {
  const cabins = filterList(r.cabins);
  // An EMPTY list matches nothing at all in the matcher. Skipped rather than
  // emitted as a false constant: the route shows no finds either way, and this
  // keeps every clause here a mirror of a matcher line rather than a shortcut
  // around one.
  if (cabins?.length) {
    parts.push(`cabin IN (${cabins.map(() => "?").join(", ")})`);
    binds.push(...cabins);
  }
  // Only above 1. `seats_available >= 1` excludes the same nothing on real data
  // and costs a bind out of a budget that decides whether this form is used.
  if (r.min_seats != null && r.min_seats > 1) {
    parts.push(`seats_available >= ?`);
    binds.push(r.min_seats);
  }
  if (r.direct_only) parts.push(`is_direct = 1`);
  if (r.point_limit != null) {
    // Against `miles_cost`, never `direct_miles_cost` — the matcher compares the
    // cheapest itinerary of any shape, and narrowing to the nonstop price here
    // would drop rows it keeps.
    parts.push(`miles_cost <= ?`);
    binds.push(r.point_limit);
  }
}

/**
 * A FILTER column's list, or `null` for "no filter" — the distinction `codeList`
 * throws away and this depends on. Mirrors `filterSet` in
 * `shared/src/match/routeMatch.ts`, deliberately including its reading of
 * malformed JSON as no filter.
 */
function filterList(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * The union of every route's airports and windows as ONE clause — what shipped
 * before the per-route form, and now the middle rung of the ladder.
 *
 * O(total width) in binds where the per-route form is O(routes x width), so it
 * still fits when that one does not. It pushes no filters: a filter is one
 * route's, and the union of several routes' filters is only as narrow as the
 * loosest of them, which on a real route set is no narrower than nothing.
 */
function unionScope(routes: readonly ScopedRoute[]): FindsScope {
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
 * is index seeks on `idx_snap_route_date` and nothing else: one per OR-group,
 * unioned by rowid, since `routeFindsScope` builds a disjunction. The filter
 * columns in those groups do NOT narrow the seeks — they sit behind
 * `flight_date`, which is a range — so they save a table fetch and a
 * `best_miles_ever` seek per rejected row, not the index walk. See
 * `routeFindsScope`.
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
