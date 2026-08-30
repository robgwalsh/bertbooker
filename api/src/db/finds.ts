import { addDaysISO } from "../domain/window.js";

/**
 * The read side of the pivot: how a set of tracked routes becomes a bounded
 * query over `finds`.
 *
 * `finds` holds one row per (route, date, program, cabin), so a find IS a row
 * and reading one is a primary-key seek. There is nothing to collapse and no
 * CTE. What is left is the interesting part — deciding how few rows the
 * database has to touch — and that is `routeFindsScope` below.
 *
 * Two callers: the Routes page (`endpoints/routes.ts`) and the alert sweep
 * (`alerts/sweep.ts`).
 */

/** Columns the Routes page projects. Callers must not reach past this list. */
export const FIND_COLUMNS = `f.origin, f.destination, f.flight_date,
       f.program, f.cabin, f.seats_available, f.miles_cost, f.cash_fees_cents,
       f.fees_currency, f.is_direct, f.segments_json,
       f.transfer_currencies, f.duration_minutes, f.booking_url,
       f.detail_level, f.enriched_at, f.source_record_id,
       f.stop_count, f.airlines, f.direct_airlines, f.direct_miles_cost`;

/**
 * A predicate narrowing which rows the read returns.
 *
 * **A scope may constrain any column `routeMatcher` reads, exactly as hard as
 * the matcher constrains it and never harder.** That is the whole contract, and
 * the only way to break it is to push a filter down here that the matcher does
 * not apply — which drops finds silently, out of the Routes page and out of
 * digests, which send no mail when they find nothing and so cannot tell you.
 *
 * Column names go in UNQUALIFIED; the text is interpolated once into a plain
 * SELECT over the bare table.
 */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/** No narrowing — the whole table. The last rung of `routeFindsScope`'s ladder,
 *  when a route set cannot be described inside D1's bind limit at all. Slow and
 *  right. */
const UNSCOPED: FindsScope = { where: [], binds: [] };

/** The `tracked_routes` columns a scope is derived from — a subset of what
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
 * `currencies` is deliberately absent; `pushFilters` says why.
 */
export interface RouteFilters {
  cabins?: string | null;
  min_seats?: number;
  direct_only?: number;
  point_limit?: number | null;
}

/** What `routeFindsScope` reads. */
export type FilteredRoute = ScopedRoute & RouteFilters;

/**
 * D1 allows **100 bound parameters per query**. `scope.binds` is consumed once
 * (`findsFrom`) and every caller appends one bind of its own, so the ceiling is
 * 99. 90 leaves room for a caller that grows.
 */
const MAX_SCOPE_BINDS = 90;

/** A JSON list column, with the scalar fallback. Mirrors `parseList` in
 *  `alerts/sweep.ts`. */
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
 * It lives beside the predicate it is a claim about even though the two are in
 * different files: this bounds the read, `shared/src/match/routeMatch.ts`
 * narrows what comes back, and **a branch added there without a matching
 * widening here silently drops finds.**
 *
 * **One OR-group per route**, each carrying that route's own airports, window
 * and filters. It is a ladder, and every rung is correct — they differ only in
 * how many rows the database touches:
 *
 *  1. **per route.** A find is read only if some route could actually show it.
 *  2. **the union** (`unionScope`), when the per-route form runs out of binds.
 *     One clause over every route's airports and the widest window, filters
 *     dropped. It re-introduces the cross product — every `PIT->HND` row read on
 *     behalf of a `PIT->BOS` route.
 *  3. **UNSCOPED**, when even that will not fit.
 *
 * The proof applies to ONE route's disjunct. For a find `f` that `routeMatcher`
 * accepts under route `tr`:
 *
 * | branch | requires | covered because |
 * | --- | --- | --- |
 * | forward | `f.origin ∈ origins`, `f.destination ∈ destinations`, date in window | `origins ⊆ O`, `destinations ⊆ D`, window ⊆ `[lo, hi]` |
 * | round trip | the reverse pair, same dates | the `round_trip` clause adds `destinations → O` and `origins → D` |
 * | first hub leg | `f.origin ∈ origins`, `f.destination ∈ via` | the hub loop adds `via → D` |
 * | second hub leg | `f.origin ∈ via`, `f.destination ∈ destinations`, date + 1 | the hub loop adds `via → O`; `hi` is widened by a day |
 *
 * The five filters the matcher then applies are conjuncts, so each may be
 * mirrored here without touching that proof. Four are (`pushFilters`);
 * `currencies` stays in JS.
 *
 * The `+1 day` is applied to EVERY route rather than only to hub routes. It is
 * trivially still a superset, costs at most one extra day of rows, and removes a
 * conditional that would otherwise have to be kept in step with the second-leg
 * branch.
 *
 * **Why `IN` lists and not `route_key` prefix ranges.** The pair set is
 * `(origins × destinations) ∪ (destinations × origins) ∪ (origins × via) ∪
 * (via × destinations)` — O(n²) in a width the UI controls, 36 pairs at the
 * maximum route shape. The sets below are O(n): nine a side worst case, and a
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
 * admits DTW->YYZ, which no branch of the matcher accepts). That looseness is
 * kept because tightening it means the O(n²) pair set argued against above.
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
 * All four columns are `NOT NULL` in `finds`, which is what makes each
 * comparison agree with the matcher's on every stored row. A nullable one would
 * not: SQL reads `NULL <= 100000` as excluded where the matcher's
 * `null > 100000` keeps.
 *
 * **`currencies` is deliberately not pushed down**, and not because `json_each`
 * is unindexable. `routeMatch.ts` reads a malformed filter column as "no filter"
 * because blanking the Routes page over one bad column is worse than showing an
 * unfiltered row; `json_each` on malformed JSON raises and fails the whole
 * request, which is the behaviour that file records as having been chosen
 * against.
 */
function pushFilters(r: RouteFilters, parts: string[], binds: unknown[]): void {
  const cabins = filterList(r.cabins);
  // An EMPTY list matches nothing in the matcher. Skipped rather than emitted as
  // a false constant: the route shows no finds either way, and this keeps every
  // clause here a mirror of a matcher line rather than a shortcut around one.
  if (cabins?.length) {
    parts.push(`cabin IN (${cabins.map(() => "?").join(", ")})`);
    binds.push(...cabins);
  }
  // Only above 1. `seats_available >= 1` excludes the same nothing on real data
  // and costs a bind out of the budget that decides whether this form is used.
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
 * The union of every route's airports and windows as ONE clause — the middle
 * rung of the ladder.
 *
 * O(total width) in binds where the per-route form is O(routes × width), so it
 * still fits when that one does not. It pushes no filters: the union of several
 * routes' filters is only as narrow as the loosest of them, which on a real
 * route set is no narrower than nothing.
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
 * finds across.
 *
 * Extracted so `routeFindsScope` and `withinRouteScope` cannot drift. Those two
 * ask the same question in opposite directions — "which finds might these routes
 * have?" and "might these routes have this find?" — and the second is an
 * AUTHORIZATION check. Built on its own hand-copied idea of what a route covers,
 * it would start refusing legitimate hub legs the first time either the `via` or
 * the `round_trip` handling moved, and it would do it as a 404 on a button that
 * used to work.
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
 * The authorization question behind `POST /api/finds/enrich`, which names a row
 * by its COORDINATES rather than by a route id — and then spends a metered
 * seats.aero call on it and writes back. Without this it would enrich anything
 * in the database, which made it the cheapest way to burn the day's quota.
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
 * Index seeks on the primary key and nothing else: one per OR-group, unioned by
 * rowid, since `routeFindsScope` builds a disjunction. The key is
 * `(origin, destination, flight_date, program, cabin)`, so a group's airports
 * and window drive the seek while its `cabin`, `seats_available` and
 * `miles_cost` conjuncts sit behind a range column — they save a row being
 * returned, not an index entry being walked.
 *
 * The alias is `f` because that is what `FIND_COLUMNS` and every caller name.
 */
export function findsFrom(scope: FindsScope): { sql: string; binds: unknown[] } {
  const where = scope.where.length ? `WHERE ${scope.where.join(" AND ")}` : "";
  return { sql: `FROM finds f ${where}`, binds: [...scope.binds] };
}
