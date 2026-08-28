-- What a slot USED to cost, kept after the award stops existing.
--
-- `availability_snapshots` is already append-on-change -- `applyTask` only ever
-- INSERTs, skipping the write when the stored `raw_hash` still matches, so every
-- row carries its own `captured_at` and the table is a real time series. Nothing
-- read it that way: every reader collapses to MAX(captured_at).
--
-- It could not be read that way either, because the prune
-- (`api/src/ingest/apply.ts`) deletes on six columns with NO `captured_at`
-- predicate. When a source covers a slice and stops reporting an offer, the
-- whole series for that (route, date, program, cabin, source) goes -- so the
-- history ended exactly at the moment it became interesting.
--
-- WHY A SECOND TABLE rather than a `deleted_at` tombstone or a narrower prune:
--
--   A NARROWER PRUNE IS WRONG, not merely expensive. `per_source` in
--   `api/src/db/finds.ts` collapses on MAX(captured_at). Delete only the newest
--   row for a key and the SECOND newest -- a real prior offer -- becomes the
--   group's max, and `findsCte` returns it as a current find. A vanished award
--   would reappear at last week's price.
--
--   A TOMBSTONE only works if the prune stops deleting, which makes
--   `availability_snapshots` grow without bound. `per_source`'s inner
--   GROUP BY ... MAX() reads every row in scope, so the app's most expensive
--   query would scan a table that only ever gets bigger -- moving the one lever
--   0005 found to be reliable in the wrong direction.
--
-- A separate table costs the read path nothing: `availability_snapshots` keeps
-- its exact shape, its exact lifecycle and its exact six-column prune, and this
-- table survives because nothing prunes it. It is the same split
-- `search_coverage` already makes -- a second table recording a fact about the
-- gathering rather than another column on the snapshot.

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_key   TEXT NOT NULL,
  -- Redundant with `route_key`'s last ten characters, and carried anyway: a
  -- retention sweep needs to seek on it, and parsing it back out of the key
  -- would make that a scan.
  flight_date TEXT NOT NULL,
  program     TEXT NOT NULL REFERENCES programs(code),
  cabin       TEXT NOT NULL,
  source      TEXT NOT NULL,
  -- NULL miles_cost = this source covered the slot and reported no offer for it.
  -- The disappearance is a point in the series, not a gap in it.
  miles_cost        INTEGER,
  seats_available   INTEGER,
  cash_fees_cents   INTEGER,
  fees_currency     TEXT,
  cash_price_cents  INTEGER,
  source_fetched_at INTEGER,
  captured_at INTEGER NOT NULL
);

-- The series for one slot, oldest first: four equality terms on the prefix and
-- an ordered scan of the last column.
CREATE INDEX IF NOT EXISTS idx_ph_slot
  ON price_history (route_key, program, cabin, captured_at);

-- The "best anyone ever saw" seek on the finds read path. PARTIAL, following
-- idx_snap_enrich: gone-rows are NULL, NULLs sort first in SQLite, and without
-- the WHERE every MIN() would scan past all of them before reaching a price.
CREATE INDEX IF NOT EXISTS idx_ph_best
  ON price_history (route_key, program, cabin, miles_cost)
  WHERE miles_cost IS NOT NULL;

-- Nothing deletes from this table yet. This is what makes a retention sweep a
-- range seek on the day it is wanted rather than a table scan.
CREATE INDEX IF NOT EXISTS idx_ph_expiry ON price_history (flight_date);

-- Seed the series from the snapshots that survive today. Write-on-change means
-- these already carry distinct `captured_at` values, so this is real history
-- rather than a flat line -- and it is why the feature has something to draw on
-- the day it ships instead of a month from now.
INSERT INTO price_history
  (route_key, flight_date, program, cabin, source, miles_cost, seats_available,
   cash_fees_cents, fees_currency, cash_price_cents, source_fetched_at, captured_at)
SELECT route_key, flight_date, program, cabin, source, miles_cost, seats_available,
       cash_fees_cents, fees_currency, cash_price_cents, source_fetched_at, captured_at
  FROM availability_snapshots;
