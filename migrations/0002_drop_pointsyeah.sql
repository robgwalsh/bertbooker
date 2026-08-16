-- PointsYeah is gone, and so is every way to run a source outside this Worker.
--
-- This migration is about the rows that source left behind, and the reason it
-- is not optional. `availability_snapshots` is current PER SOURCE and prunes
-- are scoped per source: a row is only ever refreshed or deleted by the source
-- that wrote it. Delete the source's code and nothing is left with the
-- authority to clean up after it — every `pointsyeah` row would sit in the
-- table forever, joining the dashboard as a current find and reading as award
-- space that may not have existed for months.
--
-- That is not a hypothesis. Migration 0009 (long since folded into 0001_init)
-- did exactly this for `scraper:alaska`, `browser:delta` and `mock` when the
-- carrier scrapers were abandoned; docs/HARVEST-POSTMORTEM.md §7 is the record.
-- Same failure, same fix.

-- `search_logs` first, so the ON DELETE CASCADE below has nothing to walk.
--
-- Its only writer was the `/api/ingest/*` batch handler, which wrote per-source
-- log lines from a runner nobody could watch in real time. The Worker's own
-- search streams NDJSON to the browser instead and never wrote a row here, and
-- no code has ever read one. There is nothing to preserve.
DROP TABLE IF EXISTS search_logs;

-- Availability, coverage and per-task history. Written by source id.
DELETE FROM availability_snapshots WHERE source = 'pointsyeah';
DELETE FROM search_coverage        WHERE source = 'pointsyeah';
DELETE FROM search_tasks           WHERE source = 'pointsyeah';

-- The quota table is keyed (source, day); PointsYeah was never metered and so
-- should have no rows, but the delete is free and makes this migration a
-- complete statement of "that source is gone" rather than a partial one.
DELETE FROM source_quota WHERE source = 'pointsyeah';

-- Runs opened by `npm run gather`. `search_runs.trigger` has no CHECK
-- constraint, which is how 'search', 'alert' and 'local' coexisted; 'local' is
-- now a value nothing can write. `search_tasks` and `search_coverage` cascade
-- from here, which is belt to the explicit deletes above.
DELETE FROM search_runs WHERE trigger = 'local';

-- A path on the local runner's disk to a failed task's dump. Meaningless from a
-- Worker, which has no disk, and `recordTask` no longer binds it. No index and
-- no constraint on this column, so a plain DROP COLUMN is safe.
ALTER TABLE search_tasks DROP COLUMN artifact_path;
