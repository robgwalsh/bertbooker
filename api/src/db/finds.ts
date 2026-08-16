import { PORTAL_CURRENCIES } from "../domain/programs.js";

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
 * once — the dashboard, the SPA's database browser, and `GET /api/finds` — and
 * the dashboard is the only one left. The rule survives them, because the next
 * reader added is exactly when a second hand-written collapse would creep back
 * in. The tables it reads are defined in migrations/0001_init.sql.
 */

/** Columns projected out of the collapsed set. `cash_price_cents` /
 *  `cash_price_currency` are the CARRIED-FORWARD values (see `findsCte`), not
 *  the winning row's own — callers must not reach past this list. */
export const FIND_COLUMNS = `f.origin, f.destination, f.flight_date, f.route_key,
       f.program, f.cabin, f.seats_available, f.miles_cost, f.cash_fees_cents,
       f.fees_currency, f.is_direct, f.segments_json, f.source, f.source_fetched_at,
       f.captured_at, f.transfer_currencies, f.duration_minutes,
       f.booking_url, f.cash_price_cents, f.cash_price_currency,
       f.search_run_id, f.last_checked_at,
       f.detail_level, f.enriched_at, f.source_record_id,
       f.stop_count, f.airlines, f.direct_airlines, f.direct_miles_cost`;

/** A predicate narrowing which snapshot rows enter the collapse at all. Keeping
 *  this tight matters: without it every query group-bys the whole table. */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/**
 * Build the `finds` CTE.
 *
 * Three steps, and the middle one is the subtle one:
 *
 *  1. `per_source` — the latest row per (route_key, program, cabin, **source**).
 *  2. `cash_any` — the freshest known cash fare per (route_key, program, cabin)
 *     from ANY source. A dollar fare is an attribute of the itinerary, not a
 *     competing claim about it, so it must survive its source losing the
 *     collapse; otherwise a find's portal price would blink in and out as
 *     sources take turns being freshest. (Same rule the pre-pivot
 *     `mergeContributions` applied at write time.)
 *  3. `finds` — one row per (route_key, program, cabin), the freshest
 *     `source_fetched_at` winning, with the carried cash fare coalesced in and
 *     `last_checked_at` joined from `search_coverage`.
 *
 * The bare-column-with-MAX in step 3 is SQLite-specific and deliberate: it
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
cash_any AS (
  SELECT route_key, program, cabin,
         cash_price_cents AS cp, cash_price_currency AS cc,
         MAX(source_fetched_at) AS _fresh
    FROM per_source
   WHERE cash_price_cents IS NOT NULL
   GROUP BY route_key, program, cabin
),
coverage AS (
  SELECT origin, destination, flight_date, program, MAX(checked_at) AS checked_at
    FROM search_coverage
   GROUP BY origin, destination, flight_date, program
),
finds AS (
  SELECT p.origin, p.destination, p.flight_date, p.route_key, p.program, p.cabin,
         p.seats_available, p.miles_cost, p.cash_fees_cents, p.fees_currency,
         p.is_direct, p.segments_json, p.source, p.source_fetched_at, p.captured_at,
         p.transfer_currencies, p.duration_minutes, p.booking_url,
         p.search_run_id,
         -- Whether this find describes a real aeroplane, and the handle to buy
         -- that if it does not. Attributes of the WINNING row, deliberately NOT
         -- carried forward the way cash_price_cents is: a cash fare is a fact
         -- about the itinerary whoever saw it, but an itinerary belongs to the
         -- source that claimed it, and one source's legs must never be
         -- attributed to another source's price.
         p.detail_level, p.enriched_at, p.source_record_id,
         -- Same rule as detail_level above: these describe the WINNING row's
         -- own claim about which aeroplanes serve this slot, so they are not
         -- carried forward the way a cash fare is. One source's carrier list
         -- must never be attributed to another source's price.
         p.stop_count, p.airlines, p.direct_airlines, p.direct_miles_cost,
         COALESCE(p.cash_price_cents, ca.cp) AS cash_price_cents,
         COALESCE(p.cash_price_currency, ca.cc) AS cash_price_currency,
         cov.checked_at AS last_checked_at,
         MAX(p.source_fetched_at) AS _winner
    FROM per_source p
    LEFT JOIN cash_any ca
      ON ca.route_key = p.route_key AND ca.program = p.program AND ca.cabin = p.cabin
    LEFT JOIN coverage cov
      ON cov.origin = p.origin AND cov.destination = p.destination
     AND cov.flight_date = p.flight_date AND cov.program = p.program
   GROUP BY p.route_key, p.program, p.cabin
)`;
  return { sql, binds: [...scope.binds, ...scope.binds] };
}

/**
 * "Does this find belong to this tracked route, and does it pass the route's own
 * filters?" — as a correlated predicate over `finds f` and `tracked_routes tr`.
 *
 * Its currency clause is the SQL statement of the bookability rule, whose
 * reference implementation is `bookableCurrencies()` in
 * `shared/src/providers/filter.ts`. The two halves must stay in step: the portal
 * branch is what makes an Alaska find (Bilt-only) visible to a Chase-filtered
 * view once its dollar price is known, which is the entire reason cash pricing
 * exists. There used to be a third expression here, `BOOKABLE_WITH_CLAUSE`, for
 * `GET /api/finds`; that endpoint is gone and so is it.
 *
 * This one is a shared constant because the dashboard join and the alert sweep
 * are asking exactly the same question — *what would this route show me?* — and
 * an alert that fired on a find the route's own pane hides would be
 * indistinguishable from a bug in either half.
 *
 * A correlated fragment rather than a bind-list builder because the dashboard
 * joins the whole table and the sweep joins one row of it; sharing the SQL text
 * keeps them literally identical, where two builders would only look it.
 *
 * The caller supplies the join (`tr`), the CTE (`f`), and `WHERE`
 * `ROUTE_FINDS_SEATS`. **One bind**, at the `?` in the currency clause:
 * `JSON.stringify(PORTAL_CURRENCIES)`.
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
        (
          (EXISTS (
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
           ))
        )
        AND f.flight_date BETWEEN tr.date_start AND tr.date_end
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
        --
        -- A known cash fare widens that: the seat can then be BOUGHT through
        -- any card's travel portal, whatever the program's transfer partners
        -- are. Without this clause an Alaska find (Bilt-only) stays invisible
        -- to a Chase-filtered route even when we know its dollar price — which
        -- is precisely the case cash pricing exists to surface. Mirrors
        -- bookableCurrencies() in shared/src/providers/filter.ts.
        AND (tr.currencies IS NULL
             OR EXISTS (
               SELECT 1
                 FROM json_each(tr.currencies) rc
                 JOIN json_each(f.transfer_currencies) tc ON tc.value = rc.value
             )
             OR (f.cash_price_cents IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM json_each(tr.currencies) rc
                     JOIN json_each(?) pc ON pc.value = rc.value
                 )))
        -- Nonstop-only, when the route asks for it. A READ filter and nothing
        -- more: the connecting itineraries it hides are still stored and still
        -- claim coverage, so switching this off shows them again with no
        -- re-search. Same rule the cabin filter follows: gather wide, query
        -- narrow. (No backticks in here — this is a template literal.)
        AND (tr.direct_only = 0 OR f.is_direct = 1)
      )`;

/** The route's seat floor. Separate from `ROUTE_FINDS_MATCH` only because the
 *  dashboard has always applied it in `WHERE` rather than in the join, and this
 *  extraction changes no SQL. */
export const ROUTE_FINDS_SEATS = `f.seats_available >= tr.min_seats`;

