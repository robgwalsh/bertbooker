-- The schema half of the current-only pivot. 0013 made the data fit; this makes
-- it a rule.
--
-- MUST LAND WITH A DEPLOY, and this is the one ordering hazard in the change.
-- The INSERT-only code that is live before it raises a UNIQUE violation on the
-- first changed row once `idx_snap_slot` exists, and the UPSERT that replaces it
-- cannot even be PREPARED before then — SQLite rejects an `ON CONFLICT` whose
-- target matches no unique index. There is no ordering that avoids a window, so
-- apply this and deploy back to back, just after a cron tick. The blast radius
-- is small on purpose: write-on-change means a search with nothing new still
-- succeeds, `applyTask` batches one transaction so a failure loses nothing, and
-- a failed sweep only bumps `alert_consecutive_failures`, which self-heals.

-- ---------------------------------------------------------------------------
-- What the table now IS: one row per slot, and `source` is deliberately NOT in
-- the key.
--
-- 0001 called `source` "what a prune is scoped to and what a read collapses on".
-- Neither is true after this. There has only ever been one source writing here
-- (pointsyeah's rows went in 0002), the read path no longer collapses anything,
-- and the prune keys on the slot. The column stays as provenance — it is what
-- says which source claimed a row, and `price_history` carries its own — but a
-- second source arriving is now a schema change rather than a config change.
-- That is the trade this migration makes, deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_slot
  ON availability_snapshots (route_key, program, cabin);

-- ---------------------------------------------------------------------------
-- Slim the rest. Three of these carry `captured_at`, and an UPSERT rewrites
-- every index entry whose key it touches — the same trap 0010 documented for
-- `search_coverage`, where `checked_at` changing on every upsert meant the index
-- entry was never free and the table cost 93% of the daily write allowance.
--
-- Nothing reads `captured_at` as a filter or a leading column. Outside
-- `price_history` it was only ever a MAX() ordering key, and after 0013 there is
-- nothing left to order.

-- Strict prefix of idx_snap_slot plus a trailing column nothing filters on.
DROP INDEX IF EXISTS idx_snap_lookup;

-- Same, plus `source` — which is one distinct value and now names nothing in any
-- predicate.
DROP INDEX IF EXISTS idx_snap_source_lookup;

-- Nothing has ever read `captured_at` as a leading column.
DROP INDEX IF EXISTS idx_snap_captured;

-- Rebuilt without the trailing `captured_at`. The column ORDER is unchanged and
-- must stay: 0005 chose it as the prune DELETE's key exactly, and it is still
-- the range seek behind the Routes page scope, `loadPrevious`, and the
-- bulk-enrich target scan. Only the MAX()-per-group tail is gone, because there
-- are no longer groups to take a MAX over.
DROP INDEX IF EXISTS idx_snap_route_date;
CREATE INDEX IF NOT EXISTS idx_snap_route_date
  ON availability_snapshots (origin, destination, flight_date, program, cabin, source);

-- `idx_snap_enrich` (partial, on source_record_id) is untouched — it serves
-- endpoints/enrich.ts and has nothing to do with any of this.
