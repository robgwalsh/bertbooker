-- BertBooker — the whole schema.
--
-- Applied with `npm run db:apply:local` / `:remote`. Program rows come from
-- seed/programs.sql and airport rows from seed/airports.sql; both live outside
-- migrations/ so they stay re-runnable.
--
-- THE COST MODEL BEHIND THE INDEX LIST. D1's free tier allows 100,000 rows
-- WRITTEN per day against 5,000,000 read, and it bills an index entry as a row
-- written. So on a table the ingest pipeline writes, every index is a
-- multiplier on the scarce resource while a scan is nearly free. That is why
-- the tables below carry so few indexes, and why `finds` carries none at all.


-- ===========================================================================
-- Reference data
-- ===========================================================================

-- Loyalty programs and how the couple's currencies feed them.
-- Mirrors api/src/domain/programs.ts — keep the two in sync.
--
-- `kind` spans hotels as well as airlines, and the hotel rows are real: the
-- Library page has a tab that renders them. Nothing SEARCHES a hotel program.
CREATE TABLE IF NOT EXISTS programs (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('airline', 'hotel')),
  alliance          TEXT,
  transfer_partners TEXT NOT NULL DEFAULT '[]', -- JSON: [{currency, ratio}]
  is_active         INTEGER NOT NULL DEFAULT 1
);

-- Airport reference data, from the public-domain OurAirports dataset via
-- scripts/build-airports.mjs. Standalone: no foreign key points at it and it
-- points at nothing.
--
-- `iata` is NOT declared UNIQUE, and queries that look a code up rely on it
-- being unique anyway. scripts/build-airports.mjs is what enforces that — it
-- fails rather than emit a duplicate.
CREATE TABLE IF NOT EXISTS airports (
  ident     TEXT PRIMARY KEY,   -- OurAirports identifier, e.g. KJFK
  type      TEXT,               -- large_airport | medium_airport | heliport | ...
  name      TEXT NOT NULL,
  iata      TEXT,
  icao      TEXT,
  city      TEXT,
  country   TEXT,               -- ISO 3166-1 alpha-2
  region    TEXT,               -- ISO 3166-2
  continent TEXT,
  latitude  REAL,
  longitude REAL,
  scheduled INTEGER NOT NULL DEFAULT 0  -- 1 if the field has scheduled service
);
-- The one index this table earns. `endpoints/airports.ts` seeks it for the
-- `iata > ''` range; text search goes through `airports_fts` below, and the
-- `name`/`city` LIKEs that remain use leading wildcards, which no index serves.
CREATE INDEX IF NOT EXISTS idx_airports_iata ON airports(iata);

-- The autocomplete's index. EXTERNAL CONTENT, keyed on `airports` rowids — so
-- it must be rebuilt whenever that table is reloaded, which is why
-- `db:seed:airports:local` runs seed/airports.sql and seed/airports_derived.sql
-- as one step and neither may be run alone.
--
-- It is also why a whole-database `wrangler d1 export` fails: D1 refuses to
-- export a database holding a virtual table. Scope the export to a table.
CREATE VIRTUAL TABLE IF NOT EXISTS airports_fts USING fts5(
  ident, name, city, iata, icao, country, region,
  content='airports',
  columnsize=0,
  prefix='2,3',
  tokenize='unicode61 remove_diacritics 2'
);


-- ===========================================================================
-- What the user asked for
-- ===========================================================================

-- A monitored route: a SET of city pairs, a date window, and the filters that
-- narrow what it shows.
--
-- There is no `user_email`. One shared password guards the app and everyone who
-- knows it is the same identity (`APP_USER_EMAIL`), so a column scoping rows to
-- an owner could only ever hold one value.
--
-- `origins`/`destinations`/`via`/`cabins`/`currencies` are JSON arrays. On the
-- first two, NULL means "use the scalar beside me"; on the rest it means "no
-- filter". `alert_on` is the exception to that convention and says so at the
-- column.
--
-- Two settings here change what is GATHERED rather than what is shown — `via`
-- and `round_trip` — and the difference is the whole reason to know which is
-- which: no filter can surface data that was never fetched, so turning either
-- on needs a re-search. Everything else filters the pane and costs nothing to
-- change. api/src/domain/routing.ts turns a route into seats.aero calls.
CREATE TABLE IF NOT EXISTS tracked_routes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  origin          TEXT NOT NULL,   -- IATA; the route's PRIMARY origin
  destination     TEXT NOT NULL,   -- IATA; the route's PRIMARY destination
  origins         TEXT,            -- JSON array of IATA; NULL = use the scalar
  destinations    TEXT,            -- JSON array of IATA; NULL = use the scalar
  -- Hubs to route through. GATHERING: the search plans a second query per date
  -- range for these (origins to the hubs, then the hubs to the destinations),
  -- because a cross product rides in one call but two markets cannot. It exists
  -- because a pair no program is monitored on — SFO-KTM is in nobody's graph —
  -- comes back empty forever while still being reachable with a stop. Ignored
  -- on a round trip.
  via             TEXT,
  date_start      TEXT NOT NULL,   -- ISO date
  date_end        TEXT NOT NULL,   -- ISO date, inclusive
  cabins          TEXT,            -- JSON array; NULL = any
  currencies      TEXT,            -- JSON array; NULL = any
  min_seats       INTEGER NOT NULL DEFAULT 2,
  direct_only     INTEGER NOT NULL DEFAULT 0,
  point_limit     INTEGER,         -- max miles shown; NULL = no limit, never 0
  -- GATHERING, and nearly free: seats.aero takes comma-delimited airports, so a
  -- round-trip search puts every airport on BOTH sides of ONE call and gets the
  -- return legs for the same quota. Roughly twice the rows come back per chunk,
  -- so a busy route is likelier to paginate out — which narrows its coverage
  -- claim honestly rather than corrupting anything.
  round_trip      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  -- THREE CLOCKS, and each is load-bearing. Collapsing any two re-creates a bug
  -- the others exist to prevent. docs/ALERTS.md is the full argument.
  --
  --   last_checked_at        "this route holds real data as of…". Written ONLY
  --                          when a run claimed coverage, and read by the
  --                          scheduler as a floor so a route searched by hand
  --                          five minutes ago is not swept again immediately.
  --
  --   alert_last_attempt_at  THE PACING CLOCK. Written on every sweep attempt,
  --                          pass or fail. Pacing off `last_checked_at` would
  --                          hot-loop a permanently-failing route forever: that
  --                          column is never written when a run fails, so the
  --                          route would be due on every tick and burn the day's
  --                          allowance on work that cannot succeed.
  --
  --   alert_last_digest_at   THE EMAIL CLOCK, and what makes the first sweep
  --                          silent. A route that has not been searched recently
  --                          classifies everything it finds as `new` plus a wall
  --                          of `gone` — a meaningless digest. NULL here makes
  --                          the next sweep a BASELINE: it ingests normally,
  --                          emails nothing, and stamps this column.
  last_checked_at INTEGER,

  alerts_enabled  INTEGER NOT NULL DEFAULT 0,

  -- Where the digest goes. NULL = the account's own address. Writes are checked
  -- against `alert_recipients`: with one shared password as the only auth, an
  -- unchecked value here would make this worker an arbitrary-recipient sender on
  -- a verified domain, and the domain's reputation is not something a typo
  -- should be able to spend.
  alert_email     TEXT,

  -- JSON array of ChangeType: new | more_seats | price_drop | gone.
  -- NULL = the default set, ["new","price_drop"].
  --
  -- READ THIS BEFORE COPYING THE CONVENTION FROM `cabins` ABOVE. There, NULL and
  -- `[]` both mean "no filter, everything matches". Here `[]` would mean the
  -- opposite — nothing ever fires — so the API REFUSES it with a 400 rather than
  -- storing it. NULL is the only way to say "default". A route with alerts on
  -- and no type selected is the single most plausible way for this feature to
  -- look broken while behaving exactly as configured.
  alert_on        TEXT,

  -- Default 5 rather than 0: seats.aero re-quotes constantly and a 1% movement
  -- is noise that would train you to ignore the mail.
  alert_min_drop_pct INTEGER NOT NULL DEFAULT 5,

  alert_last_attempt_at INTEGER,
  alert_last_digest_at  INTEGER,

  -- Consecutive failed sweeps, for exponential backoff. Without it a route whose
  -- window has slipped entirely into the past — the likeliest real fault, since
  -- it happens just by time passing — takes a slot in every cycle forever.
  alert_consecutive_failures INTEGER NOT NULL DEFAULT 0
);


-- ===========================================================================
-- What was found
-- ===========================================================================

-- ONE ROW PER SLOT, where a slot is (route, date, program, cabin)
--
-- NO SECONDARY INDEX, AND THAT IS THE DESIGN. The primary key is the read
-- path's access pattern, so this one b-tree serves all six queries that touch
-- the table: the Routes page's scoped seek, ingest's baseline read, the upsert's
-- conflict target, the prune, `enrich`'s per-slot lookup, and the bulk-enrich
-- scan. Each is `SEARCH ... USING PRIMARY KEY`. An index added here would be
-- paid for on every ingest write, which is the one budget that binds.
--
-- WITHOUT ROWID for the same reason: it makes the table and its key one
-- structure instead of two, so a changed find costs ONE row written rather than
-- two. D1 bills rows read rather than pages, so carrying `segments_json` inline
-- in the b-tree costs the read side nothing.
CREATE TABLE IF NOT EXISTS finds (
  origin              TEXT    NOT NULL,
  destination         TEXT    NOT NULL,
  flight_date         TEXT    NOT NULL,   -- ISO date
  program             TEXT    NOT NULL REFERENCES programs(code),
  cabin               TEXT    NOT NULL,
  seats_available     INTEGER NOT NULL,
  miles_cost          INTEGER NOT NULL,
  -- The residual tax owed on top of an award. NOT a ticket price, and NOT
  -- always USD — seats.aero quotes Aeroplan in CAD and Korean Air out of Seoul
  -- in KRW. Format with money(); never sum across currencies.
  cash_fees_cents     INTEGER NOT NULL DEFAULT 0,
  fees_currency       TEXT    NOT NULL DEFAULT 'USD',
  is_direct           INTEGER NOT NULL DEFAULT 0,
  -- How many stops, or NULL for GENUINELY UNKNOWN. Nullable is the whole point:
  -- seats.aero's Cached Search, asked without `include_trips`, reports that a
  -- connecting award exists and never says how many stops it has. A NOT NULL
  -- column would launder a guess into data.
  stop_count          INTEGER,
  -- Every carrier serving this slot, and the subset flying it NONSTOP. The pair
  -- matters more than it looks: a captured SFO->NRT row read
  -- `YAirlines: "AS, CX, JL, JX, PR"` beside `YDirectAirlines: "JL"`, so taking
  -- airlines[0] labelled a nonstop row "AS" — the one carrier that specifically
  -- does not fly it nonstop. Both are JSON arrays.
  airlines            TEXT,
  direct_airlines     TEXT,
  -- What the nonstop costs when one exists and is dearer than `miles_cost`
  -- (which quotes the cheapest itinerary of any shape). An ATTRIBUTE of this
  -- row, never a second row: a second row would collide on the primary key.
  direct_miles_cost   INTEGER,
  duration_minutes    INTEGER,
  booking_url         TEXT,
  segments_json       TEXT    NOT NULL DEFAULT '[]',
  -- Which of the couple's currencies can book this, from the source's transfer
  -- data. JSON array, e.g. ["chase_ur","bilt"].
  transfer_currencies TEXT    NOT NULL DEFAULT '[]',
  -- The source's own id for the availability record — the handle a detail fetch
  -- needs. One id covers all four cabins of a (route, date, program), so one
  -- metered call enriches up to four rows here.
  source_record_id    TEXT,
  -- 'summary' = one synthetic segment, no flight numbers. 'itinerary' = real
  -- legs.
  detail_level        TEXT    NOT NULL DEFAULT 'itinerary'
                        CHECK (detail_level IN ('summary', 'itinerary')),
  -- When a detail fetch was last spent on this row. Set even when the fetch came
  -- back with nothing usable, which is the difference between "not tried" and
  -- "tried, the source had no itinerary at this price" — without it the UI would
  -- invite the same wasted call forever.
  enriched_at         INTEGER,
  -- When the SOURCE observed it (seats.aero's `UpdatedAt`), never our fetch time.
  source_fetched_at   INTEGER NOT NULL,
  -- What the SOURCE said when this row was written. Ingest compares against this
  -- STORED value, never against a hash recomputed from the row: enrichment
  -- rewrites `segments_json` in place and the hash folds segments in, so a
  -- recomputed baseline would see every enriched row as changed and rewrite it
  -- back to a summary on the next search.
  raw_hash            TEXT    NOT NULL,
  PRIMARY KEY (origin, destination, flight_date, program, cabin)
) WITHOUT ROWID;


-- ===========================================================================
-- How the finding went
-- ===========================================================================

-- One gathering run, whoever asked for it: `trigger` is 'search' for a button
-- press and 'alert' for the cron. Deliberately no CHECK on it — a new trigger
-- should not need a migration to become storable.
--
-- The counters here are not decoration. RESUME depends on them: a run paused by
-- the sub-hourly CPU limit is picked up from `tasks_ok + tasks_failed`, an index
-- into the plan, so both must accumulate across passes rather than being
-- overwritten. `finished_at` stays NULL while paused, so a run in progress never
-- reads as complete.
--
-- Pruned to 30 days by the cron tick — see api/src/features/alerts/outbox.ts.
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,     -- uuid minted by the caller
  trigger       TEXT NOT NULL,
  -- Which tracked route this was of. `origin`/`destination` below are only that
  -- route's PRIMARY airports, so two routes sharing a pair and differing by
  -- window would be indistinguishable without this. NULL is legitimate.
  --
  -- Deliberately NOT a foreign key: deleting a route must not cascade away the
  -- record of what was gathered under it.
  route_id      INTEGER,
  origin        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'ok', 'partial', 'failed', 'aborted')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  tasks_planned INTEGER NOT NULL DEFAULT 0,
  tasks_ok      INTEGER NOT NULL DEFAULT 0,
  tasks_failed  INTEGER NOT NULL DEFAULT 0,
  offers_found  INTEGER NOT NULL DEFAULT 0,
  -- What this run SPENT at the metered source. Every other counter here measures
  -- work; this one measures money, and the scheduler needs it twice: to price a
  -- route's next sweep from what its own last sweep actually cost, and as the
  -- budget guard's fallback when no rate-limit header has been seen yet today.
  calls         INTEGER,
  -- Bounded diff summary, display only. The authoritative record is `finds`.
  changes_json  TEXT,
  error         TEXT
);
-- "What did this route's last sweep cost", per route, on every tick.
CREATE INDEX IF NOT EXISTS idx_runs_route  ON runs (route_id, started_at DESC);
-- The Alerts tab's list, and the "is a sweep still running" check.
CREATE INDEX IF NOT EXISTS idx_runs_recent ON runs (trigger, started_at DESC);
-- Covers the budget guard's SUM(calls) since 00:00 UTC without touching the
-- table.
CREATE INDEX IF NOT EXISTS idx_runs_spend  ON runs (started_at, calls);

-- What a metered source has left today, as the vendor last reported it.
-- `day` is UTC because that is when seats.aero's allowance resets.
CREATE TABLE IF NOT EXISTS source_quota (
  source      TEXT    NOT NULL,
  day         TEXT    NOT NULL,   -- 'YYYY-MM-DD', UTC
  remaining   INTEGER NOT NULL,
  limit_calls INTEGER,            -- daily ceiling; NULL when unstated
  observed_at INTEGER NOT NULL,   -- unix ms
  PRIMARY KEY (source, day)
);


-- ===========================================================================
-- The route graph
-- ===========================================================================

-- Which pairs each seats.aero program actually monitors — the input to "can this
-- route reach anything at all", and to the hub search behind `tracked_routes.via`.
--
-- `source` here is seats.aero's own program key and is NOT the same namespace as
-- `programs.code`: eight real values have no row there, which is why no foreign
-- key points at it.
--
-- Replaced wholesale per source — the payload is a program's whole network, so a
-- merge would leave pairs it has stopped flying standing forever. That makes
-- this the largest single writer in the app: ~4,000 rows deleted and re-inserted
-- across a key and two indexes for one button press. It is why there are two
-- indexes here and not three.
CREATE TABLE IF NOT EXISTS seatsaero_routes (
  source              TEXT NOT NULL,
  origin              TEXT NOT NULL,   -- IATA, exactly as the payload spells it
  destination         TEXT NOT NULL,
  origin_region       TEXT,            -- seats.aero's own words
  destination_region  TEXT,
  distance_mi         INTEGER,         -- statute miles; the unit is INFERRED
  route_id            TEXT,
  fetched_at          INTEGER NOT NULL,
  PRIMARY KEY (source, origin, destination)
);
-- The hub search chains `a.destination = b.origin`, so it needs the graph
-- indexed from both ends: this one leads the forward expansion, the next the
-- backward one. Neither is optional.
CREATE INDEX IF NOT EXISTS idx_sa_routes_pair ON seatsaero_routes (origin, destination, source);
CREATE INDEX IF NOT EXISTS idx_sa_routes_dest ON seatsaero_routes (destination, source);

-- One row per source, recording that the fetch HAPPENED.
--
-- `empty` is a SUCCESS and must never render as an error: it is the answer that
-- says a program monitors nothing, which is a different fact from never having
-- asked. `failed` leaves the previous graph exactly where it was, because a
-- refused call is not evidence about it.
CREATE TABLE IF NOT EXISTS seatsaero_route_fetches (
  source          TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed')),
  route_count     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows  INTEGER NOT NULL DEFAULT 0,
  malformed_rows  INTEGER NOT NULL DEFAULT 0,
  fetched_at      INTEGER NOT NULL,
  duration_ms     INTEGER,
  http_status     INTEGER,
  bytes           INTEGER,
  error           TEXT
);


-- ===========================================================================
-- Alerts
-- ===========================================================================

-- Who a digest may be sent to. `APP_USER_EMAIL` is always allowed and is never a
-- row here.
CREATE TABLE IF NOT EXISTS alert_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,   -- stored trimmed and lowercased
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Alertable changes not yet emailed.
--
-- This table exists because of a scheduling constraint worth stating: a Cron
-- Trigger firing more often than hourly gets 30 SECONDS of CPU. So a tick sweeps
-- one route and may pause mid-window — but the product rule is one digest per
-- sweep CYCLE. Those two only coexist if a change outlives the tick that found
-- it. It also means a tick that dies loses nothing.
--
-- `change_key` is domain/diff.ts's `changeKey` — route_key|program|cabin — and
-- is scoped by `route_id` because two routes can legitimately watch the same
-- pair with different filters and different recipients. Newest wins on conflict.
--
-- `origin`/`destination` are the CHANGE's, not the route's, and the digest
-- renders them per line.
CREATE TABLE IF NOT EXISTS alert_outbox (
  route_id    INTEGER NOT NULL REFERENCES tracked_routes(id) ON DELETE CASCADE,
  change_key  TEXT    NOT NULL,
  type        TEXT    NOT NULL,   -- ChangeType, unconstrained on purpose
  origin      TEXT    NOT NULL,
  destination TEXT    NOT NULL,
  flight_date TEXT    NOT NULL,
  program     TEXT    NOT NULL,
  cabin       TEXT    NOT NULL,
  miles_cost  INTEGER,            -- absent for 'gone'
  seats       INTEGER,            -- absent for 'gone'
  prev_miles  INTEGER,            -- absent for 'new'
  prev_seats  INTEGER,            -- absent for 'new'
  PRIMARY KEY (route_id, change_key)
) WITHOUT ROWID;

-- Every digest we tried to send, including the ones that never went out.
--
-- The audit trail is not optional here. No failure email is ever sent, so a
-- dropped digest — a refused Resend key, an unverified sender, a recipient off
-- the allowlist — leaves no other trace, and the symptom is a quiet inbox, which
-- is indistinguishable from "nothing changed". `status = 'failed'` with the
-- provider's own body in `error` is what makes that visible in the Alerts tab.
--
-- `sweep_id` is a uuid minted per flush, not a foreign key: one sweep can cover
-- several routes and therefore several runs. The primary key is the idempotency
-- backstop — one digest per recipient per sweep, so a retry after a partial
-- failure cannot double-send. The Resend request carries a matching
-- Idempotency-Key for the same reason on the provider's side.
CREATE TABLE IF NOT EXISTS alert_deliveries (
  sweep_id            TEXT NOT NULL,
  to_email            TEXT NOT NULL,
  -- 'sent'    the provider accepted it
  -- 'failed'  we tried and it was refused; `error` says what came back
  -- 'skipped' we did not try; `error` says why. Distinct from 'failed' because
  --           one is our configuration and the other is theirs.
  status              TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  subject             TEXT,
  change_count        INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (sweep_id, to_email)
) WITHOUT ROWID;
