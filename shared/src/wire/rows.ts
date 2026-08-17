// D1 row projections — what `c.json(results)` actually hands back.
//
// These are the shapes with no other written-down form. Their authority is SQL:
// a column list in a route handler, or `FIND_COLUMNS` in `api/src/db/finds.ts`.
// TypeScript cannot check an interface against a SQL string, so `.all<T>()` in
// the Worker is an ASSERTION, not a validation — each type below names the
// statement it is asserting about, and that comment is the only thing keeping
// the two honest.
//
// Note the `snake_case`: these are rows, not domain objects. The camelCase
// shapes elsewhere in this directory are hand-built by a handler and checked
// against it; these are whatever the column list says.

import type { AlertType, RunStatus } from "./domain.js";

export interface TrackedRoute {
  id: number;
  /** The route's PRIMARY airport each side. Kept as NOT NULL scalars; the
   *  authoritative sets are the JSON arrays below. */
  origin: string;
  destination: string;
  /** JSON arrays of IATA, or null — in which case the scalar above is the whole
   *  set. */
  origins: string | null;
  destinations: string | null;
  date_start: string;
  date_end: string;
  cabins: string | null; // JSON array of cabin codes, or null = any cabin
  currencies: string | null; // JSON array of currency codes, or null = any
  min_seats: number;
  /** 1 = show only nonstop finds under this route. A READ filter: connecting
   *  itineraries are still stored and still claim coverage, so turning it off
   *  brings them back with no re-search. */
  direct_only: number;
  /** 1 = this route watches BOTH directions. Unlike every other flag here this
   *  is a GATHERING setting, not a read filter: the search puts every airport on
   *  both sides of one seats.aero call, so the return legs exist only once the
   *  route has been searched with it on. Turning it on therefore needs a
   *  re-search; turning it off hides legs that stay stored. */
  round_trip: number;
  last_checked_at: number | null;
  /** 1 = the cron sweep re-searches this route and emails what changes. Like
   *  `round_trip` this changes what is GATHERED, not what is shown — it is the
   *  only other flag here that costs metered calls. See docs/ALERTS.md. */
  alerts_enabled: number;
  /** Where the digest goes; null = the account's own address. */
  alert_email: string | null;
  /** JSON array of ChangeType, or null = the default set. NEVER an empty array:
   *  the API refuses one, because "alerts on, nothing fires" is indistinguishable
   *  from broken. */
  alert_on: string | null;
  alert_min_drop_pct: number;
  alert_last_attempt_at: number | null;
  alert_last_digest_at: number | null;
  alert_consecutive_failures: number;
}

// Asserts about the shape migrations/0001_init.sql defines for search_runs.
// One row per gather, whoever asked for it: the Worker writes `search` for a
// button press and `alert` for the cron.
export interface SearchRun {
  id: string;
  user_email: string;
  trigger: "local" | "search" | "alert";
  origin: string;
  destination: string;
  date_start: string;
  date_end: string;
  programs_json: string | null;
  sources_json: string;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  tasks_planned: number;
  tasks_ok: number;
  tasks_failed: number;
  offers_found: number;
  snapshots_written: number;
  snapshots_pruned: number;
  /** Outbound metered calls this run actually spent (migrations/0006). NULL on
   *  runs written before it existed, and on local runs, which spend none. */
  calls: number | null;
  /** The tracked route this run was of (migrations/0008). NULL for a `local`
   *  run, which is a city pair someone typed rather than a saved route. */
  route_id: number | null;
  changes_json: string | null;
  error: string | null;
  host: string | null;
  runner_version: string | null;
}

// migrations/0001_init.sql — what a metered source has left today. The
// vendor's rate-limit header is only visible to whoever made the call, so it is
// written down here to be readable afterwards (and from a phone). `day` is UTC,
// because that is when seats.aero's allowance resets. A display, not a guard —
// nothing consults it before spending a call.
export interface SourceQuota {
  source: string;
  day: string;
  remaining: number;
  limit_calls: number | null;
  observed_at: number;
}

/** migrations/0007_alerts.sql — alert_deliveries. Every digest we tried to send,
 *  including the ones that never went out. With no failure email, this is the
 *  only trace a dropped digest leaves. */
export interface AlertDelivery {
  id: number;
  sweep_id: string;
  to_email: string;
  status: "sent" | "failed" | "skipped";
  subject: string | null;
  change_count: number;
  route_ids_json: string;
  run_ids_json: string;
  provider_message_id: string | null;
  error: string | null;
  created_at: number;
}

/**
 * One current find, as `findsCte` projects it. The authority is `FIND_COLUMNS`
 * in `api/src/db/finds.ts`, and every read of a stored find goes through that one
 * CTE so no two surfaces can disagree about what a current find is.
 *
 * `cabin` is `string` and NOT the `Cabin` union, deliberately: this is a
 * database row, the column is untyped TEXT, and the app's key-collision test
 * feeds it values outside the union on purpose. `Cabin` is the domain type;
 * this is the wire.
 */
export interface Find {
  tracked_route_id?: number; // which route this find belongs to (dashboard)
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  cabin: string;
  seats_available: number;
  miles_cost: number;
  cash_fees_cents: number;
  /** Cash fare for the same itinerary — NOT the award tax (that's
   *  cash_fees_cents). Null when no source could see a fare. */
  cash_price_cents?: number | null;
  cash_price_currency?: string | null;
  is_direct: number;
  source: string;
  source_fetched_at: number;
  transfer_currencies?: string; // JSON array string, e.g. '["chase_ur","bilt"]'
  /** How many stops, or null/absent for GENUINELY UNKNOWN.
   *  seats.aero's Cached Search, asked without trips, reports that a connecting
   *  award exists and never says how many stops it has. */
  stop_count?: number | null;
  /** Every carrier serving this cabin, and the subset flying it nonstop. JSON
   *  array strings. `["AS","CX","JL","JX","PR"]` beside `["JL"]` means five
   *  carriers compete and one of them is nonstop. */
  airlines?: string | null;
  direct_airlines?: string | null;
  /** What the NONSTOP costs when one exists and is dearer than `miles_cost`
   *  (which quotes the cheapest itinerary of any shape). */
  direct_miles_cost?: number | null;
  duration_minutes?: number | null;
  booking_url?: string | null;
  segments_json?: string; // JSON array of Segment (flight numbers, times, aircraft)
  /** Which run wrote this row. Absent on rows predating the pivot. */
  search_run_id?: string | null;
  /** When any source last CHECKED this (route, date, program) — from
   *  search_coverage, not from the snapshot. Null means nobody ever has, which
   *  is a different thing from "checked and still there". */
  last_checked_at?: number | null;
  /** `"summary"` means segments_json is one synthetic leg with no flight number
   *  — seats.aero said there is space at this price and nothing about which
   *  aeroplane. `"itinerary"` means the legs are real. Absent reads as an
   *  itinerary. */
  detail_level?: "summary" | "itinerary" | null;
  /** When a detail fetch was last spent on this row. Set even when the fetch
   *  came back with no matching itinerary, which is what distinguishes "not
   *  tried" from "tried, nothing at this price" — the second must not invite the
   *  same wasted API call again. */
  enriched_at?: number | null;
  /** The source's own id for the availability record. Non-null is what makes a
   *  summary row enrichable at all; seats.aero rows written before 0011 have
   *  none until the next search rewrites them. */
  source_record_id?: string | null;
}

export interface AirportInfo {
  ident: string;
  type: string;
  name: string;
  iata: string | null;
  icao: string | null;
  city: string | null;
  country: string | null;
  region: string | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduled: number;
}

/** Slim shape returned by /airports/lookup — enough to name an airport in a
 *  tooltip and to put it on the route map, and nothing else. Coordinates are
 *  nullable: OurAirports has rows without them, and RouteMap drops those stops
 *  rather than plotting a null island. */
export interface AirportName {
  iata: string;
  name: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

// Slim shape returned by /airports/geo — just what the map needs to plot points.
export interface AirportGeo {
  ident: string;
  iata: string | null;
  name: string;
  city: string | null;
  country: string | null;
  type: string;
  latitude: number;
  longitude: number;
  scheduled: number;
}

/**
 * What the route form sends, on both the create and the edit path.
 *
 * One type for both so the two surfaces cannot diverge — the header's edit mode
 * and the Add dialog render the *same* fields, and a field that only one of them
 * could express would be a setting you can choose once and never change (or the
 * reverse).
 *
 * The Worker MERGES this against the stored row, so everything past the airports
 * and dates is optional and absent means "leave alone". This was `RouteBody` in
 * `api/src/index.ts`, private and structurally duplicated here; it is one type
 * now, and `alertOn` keeps the SPA's tighter `AlertType[]` because the Worker
 * validates the strings against exactly that set anyway.
 */
export interface RouteInput {
  /** Airport SETS. The Worker still accepts the old scalar `origin`/
   *  `destination`, and stores `origins[0]` back into them as the route's
   *  primary airport. */
  origins: string[];
  destinations: string[];
  dateStart: string;
  dateEnd: string;
  /** Empty = any cabin. */
  cabins?: string[];
  /** Empty = any card. */
  currencies?: string[];
  minSeats?: number;
  /** Show only nonstop finds. Filters the pane, not the gathering. */
  directOnly?: boolean;
  /** Watch both directions. Changes the GATHERING (one call covers both), so
   *  unlike the filters above it needs a search before it shows anything. */
  roundTrip?: boolean;
  /** Enroll this route in the cron sweep. The other setting here that spends
   *  metered calls. */
  alertsEnabled?: boolean;
  /** Empty/null = the account's own address. Checked server-side against
   *  ALERT_ALLOWED_RECIPIENTS. */
  alertEmail?: string | null;
  /** Which transitions fire. `undefined` keeps what is stored, `null` resets to
   *  the default set, and an EMPTY ARRAY is a 400 — it would mean "armed and
   *  permanently silent". */
  alertOn?: AlertType[] | null;
  alertMinDropPct?: number;
}
