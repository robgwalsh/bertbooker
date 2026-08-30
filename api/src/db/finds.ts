import { addDaysISO } from "../util/dates.js";
import type { AvailabilityResult } from "../models/availability.js";
import type { EnrichTargetRow, EnrichableRow, FindsScope } from "../models/find.js";
import type { FilteredRoute, RouteFilters, ScopedRoute } from "../models/trackedRoute.js";
import type { Find } from "../../../shared/src/wire/index.js";
import type { MatchableFind } from "../../../shared/src/match/routeMatch.js";

/**
 * The `finds` table — every read of a stored find, and every write of one.
 *
 * `finds` holds one row per (origin, destination, flight_date, program, cabin),
 * is `WITHOUT ROWID`, and has NO SECONDARY INDEX. So a find IS a row, reading
 * one is a primary-key seek, and there is nothing to collapse and no CTE. A
 * changed find costs one row written, against a 100,000-a-day budget — which is
 * why an index added here is a trade to argue rather than a tidy-up.
 *
 * The file is in two halves. The first is how a set of tracked routes becomes a
 * bounded WHERE (`routeFindsScope`), which is the interesting part: it decides
 * how few rows the database has to touch, and it is a claim about
 * `shared/src/match/routeMatch.ts` that `finds.test.ts` proves. The second half
 * issues the statements — two projections over that scope, the ingest baseline,
 * the ingest upsert and prune, and the two enrichment lookups and writes.
 *
 * THE TWO PROJECTIONS ARE DELIBERATELY DIFFERENT and are named apart for it.
 * `FIND_COLUMNS` is what the Routes page draws a find from; `BASELINE_COLUMNS`
 * is what ingest diffs against, and needs `raw_hash` while not needing
 * `enriched_at`. Neither is a superset of the other, and a caller must not reach
 * past its own.
 */

/** Columns the Routes page projects. Module-private: the only statement that
 *  may use it is `selectRouteFinds`, which is in this file. */
const FIND_COLUMNS = `f.origin, f.destination, f.flight_date,
       f.program, f.cabin, f.seats_available, f.miles_cost, f.cash_fees_cents,
       f.fees_currency, f.is_direct, f.segments_json,
       f.transfer_currencies, f.duration_minutes, f.booking_url,
       f.detail_level, f.enriched_at, f.source_record_id,
       f.stop_count, f.airlines, f.direct_airlines, f.direct_miles_cost`;

/** No narrowing — the whole table. The last rung of `routeFindsScope`'s ladder,
 *  when a route set cannot be described inside D1's bind limit at all. Slow and
 *  right. */
const UNSCOPED: FindsScope = { where: [], binds: [] };

/**
 * D1 allows **100 bound parameters per query**. `scope.binds` is consumed once
 * (`findsFrom`) and every caller appends one bind of its own, so the ceiling is
 * 99. 90 leaves room for a caller that grows.
 */
const MAX_SCOPE_BINDS = 90;

/** A JSON list column, with the scalar fallback. Mirrors `parseList` in
 *  `features/alerts/alertRoutes.ts`. */
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

// ---------------------------------------------------------------------------
// The reads and writes themselves.
//
// Everything above is how a set of routes becomes a WHERE. Everything below
// issues a statement. The two projections over that shared scope are
// deliberately different — the Routes page draws a find, the sweep only needs a
// membership set — and neither may reach past its own column list.
// ---------------------------------------------------------------------------

/** The Routes page's finds. Index seeks on the primary key and nothing else:
 *  one per OR-group, unioned by rowid. */
export async function selectRouteFinds(
  db: D1Database,
  routes: readonly FilteredRoute[],
): Promise<Find[]> {
  const from = findsFrom(routeFindsScope(routes));
  const { results } = await db
    .prepare(`SELECT ${FIND_COLUMNS} ${from.sql}`)
    .bind(...from.binds)
    .all<Find>();
  return results ?? [];
}

/**
 * The columns `routeMatcher` reads, for ONE route.
 *
 * Nine, not the twenty-one `FIND_COLUMNS` projects: the answer the sweep wants
 * is a membership set, and everything else this used to compute was thrown away.
 *
 * Scoped to the one route, which is why this stopped being the most expensive
 * statement in the app: it used to pass an empty `FindsScope`, so it read every
 * find of every route to answer about one — 171,471 rows read for a route whose
 * entire input was 23.
 */
export async function selectMatchableFinds(
  db: D1Database,
  route: FilteredRoute,
): Promise<(MatchableFind & { program: string })[]> {
  const from = findsFrom(routeFindsScope([route]));
  const { results } = await db
    .prepare(
      `SELECT f.program, f.cabin, f.origin, f.destination, f.flight_date,
              f.transfer_currencies, f.is_direct, f.miles_cost, f.seats_available
         ${from.sql}`,
    )
    .bind(...from.binds)
    .all<MatchableFind & { program: string }>();
  return results ?? [];
}

/**
 * The ingest baseline's projection.
 *
 * A SECOND column list over the same table, and a `s.` alias rather than `f.`.
 * It is not `FIND_COLUMNS`: ingest needs `raw_hash` and `source_fetched_at`,
 * which the page never renders, and does not need `enriched_at`, which the page
 * does. Naming them apart is what stops one being quietly used for the other.
 */
const BASELINE_COLUMNS = `s.origin, s.destination, s.flight_date, s.program, s.cabin,
       s.seats_available, s.miles_cost, s.cash_fees_cents, s.fees_currency,
       s.is_direct, s.segments_json, s.source_fetched_at,
       s.transfer_currencies, s.duration_minutes, s.booking_url, s.raw_hash,
       s.source_record_id, s.detail_level,
       s.stop_count, s.airlines, s.direct_airlines, s.direct_miles_cost`;

/**
 * The stored rows over the span one ingest task touched.
 *
 * Deliberately a date RANGE rather than an IN-list: a stride plan can name 300
 * dates, and over-selecting is free because the slice test happens in
 * `prunable`.
 *
 * The route list matters for write-on-change, not just for pruning: leave a
 * substituted airport out of the baseline and every one of its rows looks new on
 * every run, so "a re-run writes zero rows" — the cheapest smoke test this
 * pipeline has — would quietly stop being true.
 *
 * Returns raw rows. Turning one into an `AvailabilityResult`, and carrying the
 * STORED `raw_hash` alongside it, is the caller's job: recomputing the hash asks
 * "what would this row hash to now", which stops being the right question the
 * moment anything augments a row after it was written.
 */
export async function selectBaselineFinds(
  db: D1Database,
  routes: readonly { origin: string; destination: string }[],
  lo: string,
  hi: string,
): Promise<Record<string, unknown>[]> {
  const pairs = routes.map((r) => `${r.origin}-${r.destination}`);
  const placeholders = pairs.map(() => "?").join(", ");

  // NARROWING clauses, in front of the exact pair test below.
  //
  // `(origin || '-' || destination)` is a COMPUTED expression that no index can
  // serve, so without these this query scans the whole table once per ingest
  // task. These two `IN` lists and the date range are an exact prefix of the
  // primary key, which turns the scan into a seek.
  //
  // **They narrow, they do not decide.** The pair test stays exactly as it is,
  // and it must: `prunable` filters on (flightDate, program) ONLY — it has no
  // route-pair test at all — so this list is the one thing standing between a
  // task and pruning a pair it never touched. The cross product of these two sets
  // contains pairs that are not in `routes` (touch SFO->NRT, OAK->NRT and
  // SFO->HND and the product hands you OAK->HND), and a row returned for one of
  // those would be handed to `prunable` and DELETED. Narrow with these; decide
  // with the pair list.
  const origins = [...new Set(routes.map((r) => r.origin))];
  const destinations = [...new Set(routes.map((r) => r.destination))];
  // D1 allows 100 bound parameters. Over budget, drop the narrowing rather than
  // the correctness below it: slow and right beats refused.
  const narrowBinds = origins.length + destinations.length + 2;
  const narrow = pairs.length + narrowBinds <= 100;
  const near = narrow
    ? `s.origin IN (${origins.map(() => "?").join(", ")})
          AND s.destination IN (${destinations.map(() => "?").join(", ")})
          AND s.flight_date BETWEEN ? AND ?
          AND `
    : "";
  const nearBinds = narrow ? [...origins, ...destinations, lo, hi] : [];

  const { results } = await db
    .prepare(
      `SELECT ${BASELINE_COLUMNS}
         FROM finds s
        WHERE ${near}(s.origin || '-' || s.destination) IN (${placeholders})`,
    )
    .bind(...nearBinds, ...pairs)
    .all();
  return results;
}

/**
 * Write the changed rows.
 *
 * Whether a row CHANGED is decided by the caller, against the hash stored beside
 * it — see `applyTask`. Everything reaching here is written.
 *
 * The upsert's SET list must reproduce A BRAND NEW ROW, not patch the old one.
 * `enriched_at = NULL` is the clause that came free while this was an INSERT
 * (the column is not in the list above, so a fresh row took its default) and it
 * is what reverts an enriched find to the source's own summary when the price
 * moves. Omitting it would leave last week's itinerary attached to this week's
 * price, and `detail_level` is the other half of the same revert.
 */
export async function upsertFinds(
  db: D1Database,
  rows: readonly { result: AvailabilityResult; rawHash: string }[],
): Promise<number> {
  if (!rows.length) return 0;
  const inserts = rows.map(({ result: r, rawHash }) =>
    db
      .prepare(
        `INSERT INTO finds
           (origin, destination, flight_date, program, cabin,
            seats_available, miles_cost, cash_fees_cents, fees_currency,
            is_direct, segments_json, source_fetched_at, raw_hash,
            transfer_currencies, duration_minutes, booking_url,
            source_record_id, detail_level,
            stop_count, airlines, direct_airlines, direct_miles_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin, destination, flight_date, program, cabin) DO UPDATE SET
           seats_available = excluded.seats_available,
           miles_cost = excluded.miles_cost,
           cash_fees_cents = excluded.cash_fees_cents,
           fees_currency = excluded.fees_currency,
           is_direct = excluded.is_direct,
           segments_json = excluded.segments_json,
           source_fetched_at = excluded.source_fetched_at,
           raw_hash = excluded.raw_hash,
           transfer_currencies = excluded.transfer_currencies,
           duration_minutes = excluded.duration_minutes,
           booking_url = excluded.booking_url,
           source_record_id = excluded.source_record_id,
           detail_level = excluded.detail_level,
           stop_count = excluded.stop_count,
           airlines = excluded.airlines,
           direct_airlines = excluded.direct_airlines,
           direct_miles_cost = excluded.direct_miles_cost,
           -- The SET list must reproduce A BRAND NEW ROW, not patch the old
           -- one. See the docblock above; pinned by findsSql.test.ts.
           enriched_at = NULL`,
      )
      .bind(
        r.origin,
        r.destination,
        r.flightDate,
        r.program,
        r.cabin,
        r.seatsAvailable,
        r.milesCost,
        r.cashFeesCents,
        r.feesCurrency,
        r.isDirect ? 1 : 0,
        JSON.stringify(r.segments),
        r.sourceFetchedAt,
        rawHash,
        JSON.stringify(r.bookableWith ?? []),
        r.durationMinutes ?? null,
        r.bookingUrl ?? null,
        r.sourceRecordId ?? null,
        // Absent means the source produced real legs — which is every source
        // except seats.aero's Cached Search asked without `include_trips`.
        r.detailLevel ?? "itinerary",
        // NULL is a real answer and the whole reason this column is nullable.
        r.stops ?? null,
        r.airlines?.length ? JSON.stringify(r.airlines) : null,
        r.directAirlines?.length ? JSON.stringify(r.directAirlines) : null,
        r.directMilesCost ?? null,
      ),
  );
  await db.batch(inserts);
  return inserts.length;
}

/** Delete the slots the caller's coverage claim licenses. WHAT is prunable is
 *  `prunable`'s question, not this one's. Returns the rows actually removed. */
export async function deleteFinds(
  db: D1Database,
  keys: readonly {
    origin: string;
    destination: string;
    flightDate: string;
    program: string;
    cabin: string;
  }[],
): Promise<number> {
  if (!keys.length) return 0;
  const deletes = keys.map((r) =>
    db
      .prepare(
        `DELETE FROM finds
          WHERE origin = ? AND destination = ? AND flight_date = ?
            AND program = ? AND cabin = ?`,
      )
      .bind(r.origin, r.destination, r.flightDate, r.program, r.cabin),
  );
  const results = await db.batch(deletes);
  let removed = 0;
  for (const res of results) removed += res.meta.changes ?? 0;
  return removed;
}

// ---- enrichment -----------------------------------------------------------

/**
 * The seats.aero snapshot per cabin for one (route, date, program).
 *
 * A four-column prefix of the primary key, which leaves only `cabin` free — so
 * this is at most one row per cabin by construction rather than by a filter.
 *
 * `raw_hash` rides along for the guard on the two UPDATEs below.
 */
export async function selectEnrichableRows(
  db: D1Database,
  origin: string,
  destination: string,
  flightDate: string,
  program: string,
): Promise<EnrichableRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.origin, s.destination, s.flight_date, s.program, s.cabin,
              s.miles_cost, s.source_record_id, s.detail_level, s.raw_hash
         FROM finds s
        WHERE s.origin = ? AND s.destination = ? AND s.flight_date = ? AND s.program = ?`,
    )
    .bind(origin, destination, flightDate, program)
    .all<EnrichableRow>();
  return results;
}

/**
 * The rows a bulk enrich would spend a call on.
 *
 * One row per availability id, not per find: four summary cabins share an id and
 * cost one call between them. Ordered by date so a capped run enriches the near
 * dates first, which are the ones being booked.
 *
 * `enriched_at IS NULL` is what stops a sweep re-buying nothing. A cabin
 * seats.aero had no itinerary for stays `summary` forever, so without this it
 * would be a target on every run — the same call, the same empty answer, out of
 * the same 1000. The per-row button still offers a deliberate retry; a bulk
 * sweep should not spend the day's allowance on a known miss. It also means what
 * it says: one row per slot, so there is no superseded copy carrying a stale
 * NULL and inviting a second metered call for a slot already expanded.
 *
 * Two kinds of row are worth a call, and the second only exists since the search
 * started asking for `include_trips`:
 *
 *   1. a `summary` — no itinerary at all;
 *   2. an `itinerary` MISSING ITS PER-LEG TIMES. A trip embedded in a search
 *      response carries only the whole trip's endpoints, so a connecting award
 *      arrives knowing which aeroplanes and via where, but not when it lands
 *      between them. `/trips/{id}` is still the only source of that, and it is
 *      what turns an unknown connection into a measured layover.
 *
 * Detected as "leg two exists and has no departure", which is exactly the shape
 * a chain-rebuilt itinerary has. A nonstop is fully timed already and is never a
 * target.
 *
 * Still open, and unrelated to any of that: the pair test uses the route's
 * PRIMARY airports only, so a multi-airport or hub route never bulk-enriches its
 * other pairs. That is a coverage gap, not a cost one.
 */
export async function selectEnrichTargets(
  db: D1Database,
  origin: string,
  destination: string,
  dateStart: string,
  dateEnd: string,
): Promise<EnrichTargetRow[]> {
  const { results } = await db
    .prepare(
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
    .bind(origin, destination, dateStart, dateEnd)
    .all<EnrichTargetRow>();
  return results;
}

/**
 * "We looked, and there was no trip at the stored price."
 *
 * A statement rather than an executed write, because its one caller batches it
 * beside the itinerary writes below and reconciles `meta.changes` across the
 * whole batch. Stamping `enriched_at` on a miss is the difference between an
 * inviting button and one that says so — without it the UI would offer the same
 * wasted call forever.
 *
 * The `raw_hash` guard is what makes both of these conditional: a search can
 * upsert a new price into this exact row while the metered call is in flight,
 * and the itinerary that came back was chosen against the OLD price.
 */
export function stampEnrichAttemptStatement(
  db: D1Database,
  row: EnrichableRow,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE finds SET enriched_at = ?
        WHERE origin = ? AND destination = ? AND flight_date = ?
          AND program = ? AND cabin = ? AND raw_hash = ?`,
    )
    .bind(
      now,
      row.origin,
      row.destination,
      row.flight_date,
      row.program,
      row.cabin,
      row.raw_hash,
    );
}

/**
 * Decorate one row with the itinerary that was bought for it.
 *
 * ADDITIVE by construction: `miles_cost`, `seats_available`, `cash_fees_cents`
 * and above all `raw_hash` are never touched. The row still records what
 * seats.aero's summary said, and `raw_hash` is what the next search compares
 * against — rewrite it and the next search would see a changed row, insert a
 * fresh summary on top, and throw this call away.
 *
 * `stops` is written straight rather than left NULL: an enriched row's stop
 * count is never a guess, so leaving it unknown would downgrade a fact the
 * moment the detail arrived. `is_direct` follows from it.
 */
export function enrichItineraryStatement(
  db: D1Database,
  row: EnrichableRow,
  v: {
    segmentsJson: string;
    stops: number;
    durationMinutes: number | null;
    bookingUrl: string | null;
  },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE finds SET
         segments_json = ?, stop_count = ?, duration_minutes = ?,
         booking_url = COALESCE(?, booking_url), is_direct = ?,
         detail_level = 'itinerary', enriched_at = ?
       WHERE origin = ? AND destination = ? AND flight_date = ?
         AND program = ? AND cabin = ? AND raw_hash = ?`,
    )
    .bind(
      v.segmentsJson,
      v.stops,
      v.durationMinutes,
      v.bookingUrl,
      v.stops === 0 ? 1 : 0,
      now,
      row.origin,
      row.destination,
      row.flight_date,
      row.program,
      row.cabin,
      row.raw_hash,
    );
}
