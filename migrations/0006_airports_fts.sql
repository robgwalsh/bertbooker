-- Full-text search over `airports`, so typing in an airport box stops scanning
-- the whole table.
--
-- WHY. `airportFilter` (api/src/endpoints/airports.ts) matched each token with
-- an eight-way OR, and three of those disjuncts were `LIKE '%tok%'` on `name`,
-- `city` and `region`. A leading wildcard is not sargable, so no index could be
-- used for them, and because they sat inside an OR the whole chain fell back to
-- a full scan: **72,865 rows read to return 8**, on every settled keystroke of
-- the route editor's airport autocomplete. 3.8M rows a week.
--
-- SEPARATE FROM 0005 because a virtual table is not an index — it changes what
-- the DATABASE can do, and it has a cost worth finding in its own migration
-- rather than buried in a list of CREATE INDEXes:
--
--   `wrangler d1 export` REFUSES a database containing virtual tables.
--   To export, drop `airports_fts`, export, and re-create it with this file's
--   statement plus a rebuild. Nothing in this repo exports today, and this table
--   is derived from generated reference data, so the loss is recoverable rather
--   than a data risk — but that is the trade, stated where someone hitting a
--   failed export will find it.
--
-- THE TABLE IS EMPTY WHEN THIS MIGRATION APPLIES. It is content-less by design
-- (see `content=` below) and is filled by seed/airports_derived.sql, which
-- `db:seed:airports:local` / `:remote` run immediately after the airports seed.
-- The deploy order is therefore load-bearing:
--
--   1. npm run db:apply:remote            -- creates the empty virtual table
--   2. npm run db:seed:airports:remote    -- fills it (seed + derived rebuild)
--   3. npm run deploy                     -- the worker that queries it
--
-- Deploying between 1 and 2 gives an autocomplete that finds nothing; deploying
-- before 1 gives `no such table` 500s.

-- `content='airports'` — EXTERNAL CONTENT. The row data is not duplicated; fts5
-- reads `airports` itself and stores only the index. That is the difference
-- between a rebuild costing ~150k rows written and ~15k, which matters against a
-- 100,000/day free-plan write budget.
--
-- `columnsize=0` — drops the %_docsize shadow table. Ranking here is this app's
-- own ORDER BY (exact IATA first, then scheduled, then airport size), never
-- bm25, so nothing reads column sizes.
--
-- `prefix='2,3'` — the autocomplete's whole traffic is 2- and 3-character
-- prefixes. Without these, a `"sf"*` query merges every doclist in the segment
-- beginning `sf`, which is the scan this migration exists to remove.
--
-- `remove_diacritics 2` — so "Zurich" finds "Zürich". Stated rather than left to
-- the default, which has changed between SQLite versions.
--
-- Column list mirrors the OR chain it replaces. `ident` is tokenised rather than
-- UNINDEXED because the old chain matched `ident LIKE 'tok%'`.
CREATE VIRTUAL TABLE IF NOT EXISTS airports_fts USING fts5(
  ident, name, city, iata, icao, country, region,
  content='airports',
  columnsize=0,
  prefix='2,3',
  tokenize='unicode61 remove_diacritics 2'
);
