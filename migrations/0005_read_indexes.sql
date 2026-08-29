-- Read-path indexes. Nothing here changes a row, and the only data effect is
-- that `search_coverage` SWAPS one secondary index for another.
--
-- WHY THIS EXISTS, in numbers rather than adjectives. Measured on production
-- with `wrangler d1 insights` and `wrangler d1 execute --remote`:
--
--   rows read / 24h  18,357,629   against a free-plan limit of 5,000,000
--   rows written/24h      9,179   against 100,000 -- writes were never the issue
--
--   `findsCte` (api/src/db/finds.ts) cost 168,280 ROWS READ to return 7,468,
--   on a table holding 7,900 rows, and three variants of it were 50.3M of the
--   56.9M rows read over seven days. The alert sweep spent 171,471 rows read
--   answering a question whose entire input was 23 rows.
--
-- The cause was never table size -- every table here is small. It was that the
-- read path scanned whole tables it had no need to look at. These indexes are
-- what let it stop, and each one below names the call sites it serves. Nothing
-- speculative is in this file: an index that could not be tied to a measured
-- statement was left out.

-- ---------------------------------------------------------------------------
-- search_coverage: the freshness lookup inside `findsCte`.
--
-- REPLACES idx_scov_freshness, whose only reader was the unfiltered `coverage`
-- CTE that this migration's companion code change deletes. That CTE collapsed
-- NOTHING -- there is one source, so its GROUP BY read 46,368 rows and returned
-- 46,368 -- and it ran on every Routes page load and every alert tick.
--
-- The trailing `checked_at DESC` is the whole point: four equality terms on the
-- prefix and MAX() on the last column, descending, is the shape SQLite's
-- min/max optimisation wants, so it seeks the first entry of the range and
-- stops. Verify that with EXPLAIN QUERY PLAN before trusting it -- you want
-- `SEARCH sc USING COVERING INDEX idx_scov_current`, and without the word
-- COVERING this index is not doing its job. Measured on the old index the same
-- 7,468 lookups read 74,969 rows; forced onto the PK, 30,304. The PK's trailing
-- column is `source`, not `checked_at`, which is why even it is not enough.
--
-- Swapping rather than adding is what keeps this write-neutral. This table takes
-- roughly 110,000 upserts a week and every one of them changes `checked_at`, so
-- both the old index and the new cost exactly one secondary-index entry per
-- upsert. Adding without dropping would have spent ~16k rows_written/day for
-- nothing.
-- DROPPED BY 0010 with the table itself. The write cost this paragraph calls
-- write-neutral was real and unavoidable — every upsert moved `checked_at`, so
-- every upsert rewrote an index entry — and at 48,864 upserts a day that was
-- half of 97,728 rows written. Swapping one index for another was the right
-- call for the read problem 0005 was solving; the table was the wrong thing to
-- be maintaining at all.
CREATE INDEX IF NOT EXISTS idx_scov_current
  ON search_coverage (origin, destination, flight_date, program, checked_at DESC);
DROP INDEX IF EXISTS idx_scov_freshness;

-- ---------------------------------------------------------------------------
-- availability_snapshots: the first index here that leads on the ROUTE rather
-- than on `route_key`. Five call sites, all of which table-scanned:
--
--   1. findsCte's scope predicate  (db/finds.ts, both callers)  -- range seek.
--        This index is the reason that predicate can be
--        `origin IN (...) AND destination IN (...) AND flight_date BETWEEN`
--        at all, which is the form that stays O(n) in the route's width. See
--        `routeFindsScope` for why the O(n^2) pair form was rejected.
--   2. the prune DELETE            (ingest/apply.ts)            -- EXACT six-
--        column prefix. It was a full scan PER DELETED ROW, batched, which made
--        it the worst single statement in the codebase.
--   3. loadPreviousForSource       (ingest/apply.ts)            -- range seek,
--        once per ingest task.
--   4. currentRows                 (search/enrich.ts)           -- four-column
--        prefix, called up to 25 times per bulk enrich, each a full scan.
--   5. the enrich targets scan     (endpoints/enrich.ts)        -- range seek.
--
-- Column order is the prune DELETE's key exactly, because that is the tightest
-- consumer and the one that needs all six. `captured_at` rides last so the
-- MAX(captured_at)-per-group in (1), (3) and (4) lands on the final entry of
-- each group's range without touching the table.
--
-- `route_key` is deliberately NOT in here. It is redundant with the first three
-- columns by construction (`routeKey()`, api/src/domain/types.ts) and it
-- already leads two other indexes. The width is affordable because this table
-- takes on the order of a hundred writes a day -- write-on-change means a
-- re-run with nothing changed upstream writes zero rows.
CREATE INDEX IF NOT EXISTS idx_snap_route_date
  ON availability_snapshots (origin, destination, flight_date, program, cabin, source, captured_at);

-- ---------------------------------------------------------------------------
-- search_runs: two whole-table scans, both of which run far more often than
-- they look like they do.
--
-- `SUM(calls) WHERE started_at >= ?` (alerts/budget.ts) runs once per cron tick
-- -- 96 a day -- AND once per GET /api/alerts/schedule, which the SPA's app bar
-- polls every five minutes from EVERY page (app/src/router.tsx), so one tab left
-- open is ~288 more. `calls` is in the index so the sum never reaches the table:
-- it reads today's rows and nothing else.
CREATE INDEX IF NOT EXISTS idx_srun_started_calls
  ON search_runs (started_at, calls);

-- `COUNT(*) WHERE trigger = 'alert' AND status = 'running'` (alerts/sweep.ts),
-- once per tick inside cycleComplete. COUNT(*) needs no other column, so this is
-- index-only and reads the usually-zero matching entries instead of the table.
-- Small today at 497 rows -- ~48k rows/day -- which is 0.3% of the current bill
-- and would be ~10% of the bill this migration is aiming for. That is the ratio
-- that earned it a line, and `search_runs` only grows.
CREATE INDEX IF NOT EXISTS idx_srun_trigger_status
  ON search_runs (trigger, status);
