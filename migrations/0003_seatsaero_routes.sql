-- The seats.aero ROUTE GRAPH: which city pairs each mileage program's award
-- inventory is monitored on.
--
-- Purely ADDITIVE. No existing table is touched, no row deleted, no column
-- dropped, so this applies to a live database with searches in flight.
--
-- Filled by `GET /partnerapi/routes?source=<name>` (docs/SEATS-AERO.md §12), one
-- metered call per source, on an explicit button press. A re-fetch REPLACES that
-- source's rows inside one transaction: the payload is the program's WHOLE
-- graph, so a merge would leave pairs a program has stopped flying standing
-- forever, and a partial write would be a lie about the shape of its network.
--
-- This is reference data, NOT availability. Nothing here is a find, nothing
-- claims search coverage, and nothing is reachable from findsCte. Per
-- docs/SOURCES.md a source is "anything that can answer what award space exists
-- on this route, on these dates" — a route graph answers neither half of that,
-- so this is not a source and gets no SourceDescriptor.


CREATE TABLE IF NOT EXISTS seatsaero_routes (
  -- seats.aero's OWN `Source` value: 'aeroplan', 'british', 'copa'. This is the
  -- KEY side of SEATSAERO_PROGRAM_MAP, and it is NOT the source plug-in id that
  -- `availability_snapshots.source` and `source_quota.source` store. Every row
  -- here came from the `seatsaero` plug-in, so that fact is a property of the
  -- TABLE rather than of a column, which is what frees this column to mean the
  -- other thing. Read it as "the program key".
  --
  -- Deliberately NO foreign key to programs(code). The eight real-but-unmapped
  -- sources (velocity, smiles, azul, copa, finnair, saudia, ethiopian,
  -- eurobonus) have no program row, and being able to look at their graphs is
  -- part of the point. Mapping to a programs.code happens at READ time through
  -- SEATSAERO_PROGRAM_MAP, which stays the one owner of it.
  source              TEXT NOT NULL,

  origin              TEXT NOT NULL,   -- IATA, exactly as the payload spells it
  destination         TEXT NOT NULL,   -- IATA
  origin_region       TEXT,            -- seats.aero's own words; six observed values
  destination_region  TEXT,

  -- STATUTE MILES, and the unit is INFERRED rather than documented: the API
  -- reference gives TPE-PNH as 1423, and that pair's great circle is 2290 km =
  -- 1423 mi. Named for the unit so no reader re-derives it, the same way
  -- cash_fees_cents and duration_minutes are.
  --
  -- INTEGER because it is: 16,468 rows measured across two sources on
  -- 2026-08-18 had no fractional value. Zero occurs and means nothing useful.
  distance_mi         INTEGER,

  -- seats.aero's own id for the pair (a ksuid). Carried because it costs
  -- nothing and is what a future /partnerapi/availability?source= would join
  -- on. Nothing reads it yet.
  route_id            TEXT,

  fetched_at          INTEGER NOT NULL, -- unix ms, OUR fetch

  -- One row per (program key, pair). Measured safe: alaska and aeroplan each
  -- returned every pair exactly once (8,130/8,130 and 8,338/8,338 distinct).
  -- The writer dedupes on this key anyway and counts what it dropped, which is
  -- what lets this be a strict PRIMARY KEY with a plain INSERT — one duplicate
  -- row would otherwise abort the transaction and waste a metered call.
  PRIMARY KEY (source, origin, destination)
);

-- "Who flies this pair?" — the lookup surface, and the reach check's one hot
-- query. Both ask ACROSS sources, so neither can start from the primary key,
-- whose leading column is the source.
CREATE INDEX IF NOT EXISTS idx_sa_routes_pair
  ON seatsaero_routes (origin, destination, source);

-- "What flies INTO this airport?" A destination-only filter can use neither the
-- index above nor the primary key: wrong leading column for both.
CREATE INDEX IF NOT EXISTS idx_sa_routes_dest
  ON seatsaero_routes (destination, source);

-- The region filters, scoped by the source the table is already showing. Region
-- values are six repeated words, so this is only worth anything with `source`
-- leading — which is also the only way the table ever asks. There is
-- deliberately NO index for the distance range: it is always applied inside an
-- already source-scoped set, and a range scan over one program's ~8k rows is
-- cheaper than a fourth index to rebuild on every replace.
CREATE INDEX IF NOT EXISTS idx_sa_routes_regions
  ON seatsaero_routes (source, origin_region, destination_region);


-- Did we ask this source for its graph, and what did it say?
--
-- THIS TABLE IS THE POINT OF THE FEATURE, and the reason is hard-won.
-- **seats.aero answers 200 with an EMPTY ARRAY for a source name it does not
-- recognise.** It does not error and it does not 404. So `britishairways`,
-- `ana`, `cathay` and `eva` — four entirely plausible guesses — are
-- indistinguishable from a real program that happens to fly nowhere, unless the
-- FETCH ITSELF is written down. Without this table, "no rows for X" means
-- either "we never asked" or "that name is wrong", and every reader downstream
-- has to guess which. docs/SEATS-AERO.md §4 records that costing real time;
-- this table is that verification ritual turned into data.
--
-- One row per source, upserted. A re-fetch replaces the graph, so there is one
-- current answer per source and a history would answer nothing the rows do not.
CREATE TABLE IF NOT EXISTS seatsaero_route_fetches (
  source          TEXT PRIMARY KEY,  -- the program key, as in seatsaero_routes

  -- 'ok'     rows came back and all of them are stored.
  -- 'empty'  the call SUCCEEDED and returned zero routes. Almost always a
  --          source name seats.aero does not know. THE DISTINCTION THIS TABLE
  --          EXISTS FOR: it is a 200, not a failure, and must never read as one.
  -- 'failed' the call threw or answered non-2xx. Nothing was replaced, and the
  --          previous graph, if any, is still standing.
  status          TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed')),

  -- Not named `rows`: ROWS is a SQLite keyword (window frames) and would need
  -- quoting in exactly the contexts this column is useful in.
  route_count     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows  INTEGER NOT NULL DEFAULT 0,  -- (origin,destination) dupes dropped
  malformed_rows  INTEGER NOT NULL DEFAULT 0,  -- rows missing an endpoint

  fetched_at      INTEGER NOT NULL,            -- unix ms, when the call returned
  duration_ms     INTEGER,
  http_status     INTEGER,
  bytes           INTEGER,                     -- response size, for the ledger
  error           TEXT                         -- the failure's own words
);
