-- Make `availability_snapshots` hold one row per slot. DATA ONLY — the unique
-- index that enforces it is 0014, and this file is deliberately safe under the
-- code that is deployed right now.
--
-- The table has been append-on-change since 0001: `applyTask` only ever
-- INSERTs, so a slot whose price moves grows a row and the old one stays. That
-- made it a real time series, and 0009 already recorded that nothing reads it as
-- one: every reader collapses to MAX(captured_at), and the prune deletes on six
-- columns with no `captured_at` predicate, so a slot's whole series vanishes the
-- moment the award does.
--
-- MEASURED, 2026-08-29: 16,768 rows over 7,775 distinct (route_key, program,
-- cabin). 54% of the table was superseded versions, and the share was growing —
-- the table gained 5,081 rows in a few hours while distinct slots gained 12.
-- Every one of those rows was read by `per_source`'s MAX() on every Routes page
-- load and every alert tick.
--
-- Deleting them costs no history. `price_history` (0009) is the series, it
-- already holds a point for every snapshot ever written, and it holds the
-- disappearances snapshots structurally cannot express.
--
-- Both statements are re-runnable: the insert is guarded by NOT EXISTS, and the
-- delete is a no-op once there is one row per group.

-- ---------------------------------------------------------------------------
-- 1. Belt and braces. Provably inserts nothing today, and is here so that if
--    that stops being true before this is applied, the observation is kept.
--
-- THE PREDICATE IS TOLERANT ON `captured_at` ON PURPOSE, and an exact match
-- here would be a bug that looked like a finding. The two tables keep different
-- clocks: `apply.ts` binds no `captured_at`, so a snapshot takes the column
-- DEFAULT `unixepoch() * 1000` — second granularity, and 0 of 16,768 rows carry
-- a sub-second value. `priceStatements` binds `Date.now()`, of which 7,371 rows
-- do. Two rows written in the SAME `db.batch()` therefore differ by
-- milliseconds. Matching exactly called 7,231 rows orphans; matching on VALUE
-- inside a ten-second window calls ZERO.
INSERT INTO price_history
  (route_key, flight_date, program, cabin, source, miles_cost, seats_available,
   cash_fees_cents, fees_currency, source_fetched_at, captured_at)
SELECT s.route_key, s.flight_date, s.program, s.cabin, s.source,
       s.miles_cost, s.seats_available, s.cash_fees_cents, s.fees_currency,
       s.source_fetched_at, s.captured_at
  FROM availability_snapshots s
 WHERE NOT EXISTS (
   SELECT 1 FROM price_history ph
    WHERE ph.route_key = s.route_key
      AND ph.program   = s.program
      AND ph.cabin     = s.cabin
      AND ph.miles_cost      IS s.miles_cost
      AND ph.seats_available IS s.seats_available
      AND ph.captured_at BETWEEN s.captured_at - 10000 AND s.captured_at + 10000
 );

-- ---------------------------------------------------------------------------
-- 2. Keep the newest row per slot.
--
-- THE `id DESC` TIE-BREAK IS LOAD-BEARING. `captured_at` is second-granular, so
-- every row of one ingest batch shares a value and `MAX(captured_at)` alone does
-- not say which row survives — it would pick arbitrarily, and on a tie could
-- pick an older observation. The highest id is the latest INSERT, which is the
-- row the read path returns today.
DELETE FROM availability_snapshots
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (PARTITION BY route_key, program, cabin
                               ORDER BY captured_at DESC, id DESC) AS rn
       FROM availability_snapshots
   ) WHERE rn > 1
 );
