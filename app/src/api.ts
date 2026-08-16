// Thin typed fetch helpers against the API worker. Every path here is relative
// and that is deliberate: in prod the same worker serves this bundle and answers
// /api/*, so there is no base URL to configure; in dev vite.config.ts proxies
// /api to :8787.

import { notifyLocked } from "./auth";

/** `GET /api/dashboard` — every tracked route plus every current find under it,
 *  each tagged with its `tracked_route_id`. Still called "dashboard" on the wire
 *  after the page became **Routes**: the endpoint's name is not the page's, and
 *  renaming it would move the Worker route, three query-key invalidations and
 *  nothing else. One request for all routes is deliberate — it is what lets the
 *  route rail show a find count per route without a query each. */
export interface DashboardData {
  trackedRoutes: TrackedRoute[];
  bestFinds: Find[];
}

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

/** The four transitions `diffAvailability` classifies — mirrors
 *  `ALL_ALERT_TYPES` in shared/src/alerts/select.ts. */
export const ALERT_TYPES = ["new", "price_drop", "more_seats", "gone"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** api/src/alerts/routes.ts — GET /api/alerts/schedule. */
export interface AlertSchedule {
  /** Whether `POST /api/alerts/run` exists on this host — true under
   *  `wrangler dev`, false in production. The gate on every manual-tick
   *  control; see `alertRunTick`. */
  manualTick: boolean;
  pacing: {
    affordable: boolean;
    intervalMinutes: number | null;
    cycleCost: number;
    /** Present when unaffordable: 'no_routes' | 'cycle_exceeds_budget'. */
    reason?: string;
    cyclesPerDay?: number;
    dailyBudget?: number;
    unsearchable: number[];
  };
  budget: {
    dailyBudget: number;
    reserve: number;
    maxCallsPerTick: number;
    selfSpentToday: number;
    observedRemaining: number | null;
    /** 'observed' | 'self_accounted' — early in a UTC day nothing has reported
     *  a number and the guard reasons from our own records instead. */
    basis: string;
    wouldSweepNow: boolean;
    blockedReason: string | null;
  };
  email: {
    configured: boolean;
    from: string | null;
    allowedRecipients: string[];
  };
  routes: AlertScheduleRoute[];
}

export interface AlertScheduleRoute {
  id: number;
  label: string;
  chunks: number;
  /** The window has fallen entirely into the past — the route cannot be swept
   *  at all, which is different from merely idle. */
  windowExpired: boolean;
  estimatedCalls: number;
  observedCalls: number | null;
  alertOn: AlertType[];
  alertMinDropPct: number;
  recipient: string;
  lastAttemptAt: number | null;
  lastDigestAt: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  due: boolean;
  /** The next sweep will be a SILENT baseline — see docs/ALERTS.md. */
  awaitingBaseline: boolean;
}

/**
 * api/src/alerts/sweep.ts — `TickResult`, the whole of what one tick
 * decided.
 *
 * Mirrored in full rather than summarised to an `ok`, because a tick that swept
 * nothing has to be able to say why: `pacing` and `skipped` are the difference
 * between "nothing was due" and "the budget guard refused", which look identical
 * from `sweptRouteIds` alone.
 */
export interface AlertTickResult {
  sweptRouteIds: number[];
  /** Reasons a route was passed over: 'reserve' | 'exhausted' (budget guard),
   *  'not_alert_route' | 'window_expired' (a forced id that cannot be swept). */
  skipped: { routeId: number; reason: string }[];
  /** Digests sent, once the cycle completed. Usually 0. */
  flushed: number;
  /** `every Nm`, or the reason there is no cadence at all
   *  ('no_alert_routes' | 'no_app_user_email' | 'cycle_exceeds_budget' | 'no_routes'). */
  pacing: string;
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
 * What the route form sends, on both the create and the edit path.
 *
 * One type for both so the two surfaces cannot diverge — the header's edit mode
 * and the Add dialog render the *same* fields, and a field that only one of them
 * could express would be a setting you can choose once and never change (or the
 * reverse). Mirrors `RouteBody` in `api/src/index.ts`.
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

export interface ProgramInfo {
  code: string;
  name: string;
  kind: "airline" | "hotel";
  alliance: string | null;
  transfer_partners: { currency: string; ratio: string }[];
  is_active: number;
}

export interface CurrencyInfo {
  code: string;
  name: string;
  /** Cents one point is worth in this currency's own travel portal, for pricing
   *  a cash fare in points. Absent = no portal (miles held directly). */
  portalCentsPerPoint?: number;
  portalName?: string;
}

// shared/src/data/airlines.ts — a carrier plus the program codes whose
// miles can book it. Join `programs` against `api.programs()` for display.
export interface AirlineInfo {
  code: string;
  name: string;
  country: string;
  alliance: string | null;
  programs: string[];
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

// ---- Gathering wire types ----
// Hand-mirrored from the worker. The SPA imports nothing from `shared/` — that
// code references D1Database at module scope and fights a DOM tsconfig — so
// each type below names its source file instead. **That hand-mirroring is a real
// seam, and it has bitten:** `PRIMARY_METERED_SOURCE` in QuotaIndicator.tsx sat
// on a stale source id for months after a migration renamed it, and every quota
// lookup silently matched nothing. Keep these in sync deliberately.

// shared/src/ingest/types.ts. The distinction that carries the whole
// design: only `ok` and `empty` claim coverage. Everything else means "we never
// got an answer", which is why a blocked task can't delete anything.
export type SourceTaskStatus =
  | "ok"
  | "empty"
  | "failed"
  | "skipped"
  | "blocked"
  | "challenged"
  | "timeout";

export type RunStatus = "running" | "ok" | "partial" | "failed" | "aborted";

// migrations/0001_init.sql — search_runs (`harvest_runs` until migration 0009).
// One row per gather, whoever asked for it. The Worker writes `search` (a human
// pressed the button) and `alert` (the cron did); `local` was a gatherer that
// ran outside Cloudflare, and 0002 deleted its rows.
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

/** GET /api/quota. `today` travels with the payload so the SPA doesn't
 *  have to agree with the server about the UTC date to find today's row. */
export interface QuotaPage {
  today: string;
  quota: SourceQuota[];
}

// shared/src/diff.ts — stored on search_runs.changes_json, display only.
export interface ChangeSummary {
  type: "new" | "more_seats" | "price_drop" | "gone";
  key: string;
  flightDate: string;
  program: string;
  cabin: string;
  milesCost?: number;
  seatsAvailable?: number;
  previousMilesCost?: number;
  previousSeats?: number;
}

// api/src/search.ts — one NDJSON frame from
// POST /api/tracked-routes/:id/search.
//
// All of this happens in the WORKER: the seats.aero Partner API is a keyed
// vendor API that Cloudflare's IPs can reach, so searching a tracked route needs
// nothing running on this machine. The unit of progress is a 90-day date chunk,
// and each chunk is already applied to D1 by the time its `chunk_done` frame
// lands.
/** One HTTP call to seats.aero. Mirrors `SeatsAeroCall` in
 *  `shared/src/providers/seatsaero.ts`.
 *
 *  `requestHeaders` arrives with the API key already replaced by `<redacted>`;
 *  the redaction happens server-side, on a copy, and this type never sees the
 *  real value. */
export interface SearchCall {
  /** 1-based page within its chunk. */
  index: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status?: number;
  ok: boolean;
  startedAt: number;
  durationMs: number;
  responseHeaders?: Record<string, string>;
  bytes: number;
  rows?: number;
  /** Absent when the capture budget was spent — see `bodyOmitted`. */
  body?: string;
  bodyTruncated?: boolean;
  bodyOmitted?: boolean;
  error?: string;
}

export type SearchEvent =
  | {
      type: "run_start";
      runId: string;
      origin: string;
      destination: string;
      chunks: { start: string; end: string }[];
      /** Every city pair this search covers. */
      pairs: { origin: string; destination: string }[];
      /** Total tasks. `chunks.length` is what one request may cover. */
      total: number;
      /** Where this REQUEST starts — non-zero when resuming. */
      from: number;
    }
  | {
      type: "chunk_start";
      index: number;
      total: number;
      start: string;
      end: string;
      origins: string[];
      destinations: string[];
    }
  | ({ type: "call"; chunkIndex: number } & SearchCall)
  | {
      type: "chunk_done";
      index: number;
      start: string;
      end: string;
      status: SourceTaskStatus;
      offersFound: number;
      snapshotsWritten: number;
      snapshotsPruned: number;
      /** Outbound seats.aero calls this chunk spent. */
      calls: number;
      durationMs: number;
      /** Present when the chunk narrowed its own coverage claim. */
      note?: string;
      error?: string;
    }
  | { type: "quota"; remaining: number; limit?: number; observedAt: number }
  /** The request stopped early to stay inside the Worker's subrequest budget.
   *  A THIRD terminal frame beside `run_done` and `error` — the caller must
   *  re-issue from `nextIndex` until one of the other two arrives. Mirrors
   *  api/src/search.ts. */
  | { type: "run_continue"; runId: string; nextIndex: number; total: number; calls: number }
  | {
      type: "run_done";
      runId: string;
      status: Exclude<RunStatus, "running">;
      chunksOk: number;
      chunksFailed: number;
      offersFound: number;
      snapshotsWritten: number;
      snapshotsPruned: number;
      calls: number;
      durationMs: number;
    }
  | { type: "error"; message: string };

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

/** Availability rows one "Enrich all" will expand — mirrors `ENRICH_MAX_PER_RUN`
 *  in api/src/enrich.ts, which is the authority. Held here only so the
 *  confirm dialog can quote the true cost before the request is made; the server
 *  enforces it either way, and over-quoting would be the safer error. */
export const ENRICH_MAX_PER_RUN = 25;

/** Result of enriching one find — mirrors `EnrichOutcome` in
 *  api/src/enrich.ts. One call covers every cabin of the availability,
 *  so this reports several. */
export interface EnrichResult {
  enriched: { cabin: string; stops: number; durationMinutes?: number; flights: string }[];
  skipped: { cabin: string; reason: string }[];
  notes: string[];
  quotaRemaining?: number;
}

/** Mirrors `EnrichEvent` in api/src/enrich.ts. */
export type EnrichEvent =
  | { type: "run_start"; targets: number; totalTargets: number; capped: boolean }
  | {
      type: "item";
      index: number;
      total: number;
      flightDate: string;
      program: string;
      status: SourceTaskStatus;
      cabins: string[];
      error?: string;
    }
  | { type: "quota"; remaining: number; observedAt: number }
  | {
      type: "run_done";
      enriched: number;
      failed: number;
      empty: number;
      calls: number;
      durationMs: number;
      capped: boolean;
      /** Eligible rows this run did NOT reach, because of the per-run cap. */
      remaining: number;
    }
  | { type: "error"; message: string };

// One flown leg, as stored in segments_json (mirrors `Segment` in shared/src/types.ts).
export interface Segment {
  from: string;
  to: string;
  carrier: string;
  flightNumber?: string;
  aircraft?: string;
  departsAt?: string; // ISO local, e.g. "2026-08-06T11:21:00"
  arrivesAt?: string;
  cabin?: string;
}

// Search criteria shared by the airports table and the airports map.
export interface AirportSearchOpts {
  iataOnly?: boolean;
  scheduled?: boolean;
  continent?: string;
  country?: string;
  types?: string[];
  limit?: number;
}

function airportParams(q: string, opts?: AirportSearchOpts): string {
  const params = new URLSearchParams({ q });
  if (opts?.iataOnly) params.set("iataOnly", "1");
  if (opts?.scheduled) params.set("scheduled", "1");
  if (opts?.continent) params.set("continent", opts.continent);
  if (opts?.country) params.set("country", opts.country);
  if (opts?.types?.length) params.set("type", opts.types.join(","));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  return params.toString();
}

/** A failed API response, carrying the two things a caller might branch on. The
 *  message keeps the old `GET /path -> 401` shape, because that is what any
 *  existing error UI is already rendering. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The Worker's machine-readable `{"error":...}` code, when it sent one. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Every gated call goes through here.
 *
 * The session is an HttpOnly cookie, so there is nothing to attach — the browser
 * does it, and `credentials` is stated rather than left to the default so the
 * reason is visible at the call site. What this adds is the lockout hand-off: a
 * 401 whose body says `locked` is reported to `auth.ts`, which turns "this one
 * query failed" into "show the password dialog" instead of every panel on the
 * page failing separately with a generic error.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    const code = detail?.error ?? null;
    if (res.status === 401 && code === "locked") notifyLocked();
    throw new ApiError(
      res.status,
      code,
      `${init?.method ?? "GET"} ${path} -> ${res.status}${code ? ` ${code}` : ""}`,
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Yield newline-delimited JSON frames from a streaming response.
 *
 * Shared by the two streams in this app — the Worker's route search and its
 * enrich-all — because the buffering rule is the easy thing to get subtly wrong:
 * a chunk boundary can land mid-frame, so anything after the last newline stays
 * buffered until more arrives.
 *
 * Says nothing about terminal frames; that contract belongs to each stream and is
 * enforced by its caller. Both hold the same rule: a stream that ends without a
 * `run_done` or `error` frame died mid-flight and must be read as a failure,
 * never as an empty result.
 */
async function* readNdjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) throw new Error("stream returned no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as T;
}

/** How long the UI waits on a whole route search. Five 90-day chunks at a couple
 *  of seconds each is the normal case; this is only here so a wedged connection
 *  eventually gives up instead of spinning until the tab closes. */
const SEARCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Search one tracked route against seats.aero, yielding each frame as it arrives.
 *
 * Deliberately not TanStack Query: this is a stream whose *partial* state is the
 * point (chunk rows filling in one at a time), not a request/response a cache can
 * hold. Every chunk's finds are already in D1 by the time you see its frame, so
 * invalidating `["dashboard"]` at the end is a refresh, not the delivery.
 *
 * Failures before the first byte arrive as a status code, because the Worker does
 * everything fallible before opening the stream — a missing API key is a 503 here
 * and must surface as an error, never as "no award space found".
 *
 * **A wide route takes several HTTP requests, and this generator hides that.**
 * The Worker stops after a bounded number of outbound calls so it stays inside
 * its subrequest budget, and says so with a `run_continue` frame; this resumes
 * from `nextIndex` under the same run id until `run_done` or `error`. Consumers
 * see one continuous stream and one terminal frame, which is what keeps the
 * "a stream that ends without a terminal frame is a failure" rule simple for
 * every caller. `run_continue` is still yielded, so a UI can show the pause.
 */
export async function* searchRoute(
  id: number,
  signal?: AbortSignal,
): AsyncGenerator<SearchEvent> {
  let runId: string | undefined;
  let from = 0;

  // Bounded so a Worker that somehow always pauses cannot spin forever. One
  // request per group-chunk is the worst legitimate case.
  for (let request = 0; request < 64; request++) {
    const query = runId ? `?runId=${encodeURIComponent(runId)}&from=${from}` : "";
    const path = `/tracked-routes/${id}/search${query}`;
    const res = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      // This stream doesn't go through `req`, so the lockout hand-off is repeated
      // here — a search started on a session that lapsed mid-afternoon has to
      // raise the dialog, not just report a failed search.
      if (res.status === 401 && detail?.error === "locked") notifyLocked();
      throw new Error(SEARCH_ERRORS[detail?.error ?? ""] ?? `POST ${path} -> ${res.status}`);
    }

    let paused = false;
    for await (const event of readNdjson<SearchEvent>(res)) {
      if (event.type === "run_continue") {
        runId = event.runId;
        from = event.nextIndex;
        paused = true;
      }
      yield event;
    }
    if (!paused) return;
    if (signal?.aborted) return;
  }
}

/**
 * Enrich every summary find under one tracked route, yielding each frame.
 *
 * Same shape and same rules as `searchRoute`: fallible checks land as status
 * codes before the first byte, and a stream that ends without a terminal frame
 * is a failure — never "nothing needed enriching".
 */
export async function* enrichRoute(
  id: number,
  signal?: AbortSignal,
): AsyncGenerator<EnrichEvent> {
  const path = `/tracked-routes/${id}/enrich`;
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401 && detail?.error === "locked") notifyLocked();
    throw new Error(SEARCH_ERRORS[detail?.error ?? ""] ?? `POST ${path} -> ${res.status}`);
  }
  yield* readNdjson<EnrichEvent>(res);
}

/** The Worker's pre-stream refusals, in words a person can act on. Shared by
 *  `searchRoute` and `enrichRoute` — the two overlap on every code but their
 *  own, and duplicating the map would let them drift. */
const SEARCH_ERRORS: Record<string, string> = {
  no_seats_aero_key:
    "seats.aero API key not configured — set SEATS_AERO_API_KEY (api/.dev.vars locally, or a Worker secret).",
  window_outside_horizon:
    "This route's date window is entirely in the past or beyond seats.aero's ~1 year horizon.",
  not_found: "That route no longer exists.",
  nothing_to_enrich:
    "Every seats.aero find on this route already has its itinerary — nothing left to fetch.",
  locked: "Your session expired. Enter the password again and re-run the search.",
  no_app_password:
    "The API has no APP_PASSWORD configured — set it with `wrangler secret put APP_PASSWORD`.",
  no_session_secret:
    "The API has no SESSION_SECRET configured — set it with `wrangler secret put SESSION_SECRET`.",
};

// ---------------------------------------------------------------------------
// The password gate
// ---------------------------------------------------------------------------
// Mirrors `api/src/gate.ts`, by hand, like every other wire type in this
// file. These three calls are the only ones outside the gate, and they bypass
// `req` on purpose: a wrong password is a 401 that must reach the dialog as a
// message, not trip the global lockout handler that `req` owns.
//
// **No token crosses this boundary.** Login answers with a `Set-Cookie` the
// browser stores and this code cannot see; `expiresAt` is the only thing in the
// body, and it is a hint about when to re-prompt, not a credential.

/** Response of `GET /api/auth/session` — mirrors gate.ts. */
export interface SessionState {
  /** False means the Worker is missing a required secret, so no password can
   *  ever work. A misconfiguration to report, not a login to prompt for. */
  configured: boolean;
  /** Which secret is missing, when `configured` is false. */
  reason?: "no_app_password" | "no_session_secret";
  authenticated: boolean;
  /** Epoch seconds, or null when not signed in. */
  expiresAt: number | null;
}

/** Response of `POST /api/auth/login` — mirrors gate.ts. The session itself
 *  arrives as an HttpOnly cookie, which is why there is no token here. */
export interface LoginResult {
  expiresAt: number;
}

async function session(): Promise<SessionState> {
  const res = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, null, `GET /auth/session -> ${res.status}`);
  return (await res.json()) as SessionState;
}

/** Exchange the shared password for a session cookie. Throws `ApiError` with
 *  code `bad_password` on a wrong one, or `no_app_password` /
 *  `no_session_secret` if the Worker is missing a secret. */
async function login(password: string): Promise<LoginResult> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = (await res.json().catch(() => null)) as
    | (Partial<LoginResult> & { error?: string })
    | null;
  if (!res.ok || typeof body?.expiresAt !== "number") {
    throw new ApiError(res.status, body?.error ?? null, `POST /auth/login -> ${res.status}`);
  }
  return { expiresAt: body.expiresAt };
}

/**
 * Clear the session cookie. Never throws: sign-out is a thing the user asked
 * for, and a failed request is no reason to leave them looking at an app they
 * think they have left. The client-side clear happens regardless.
 *
 * The `Content-Type` is not decoration on a request with no body. The Worker's
 * `csrf` middleware guards exactly the requests a cross-site *form* could have
 * made, and a POST with no content type counts as one — so without this header
 * this call is refused 403 by our own CSRF protection. Declaring JSON is also
 * what makes the guard correct rather than incidental: browsers cannot send that
 * content type cross-site without a preflight, which our CORS policy refuses.
 */
async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  }).catch(() => {});
}

export const api = {
  // ---- The password gate (outside it, necessarily) ----
  session,
  login,
  logout,

  dashboard: () => req<DashboardData>("/dashboard"),
  programs: () => req<ProgramInfo[]>("/programs"),
  currencies: () => req<CurrencyInfo[]>("/currencies"),
  airlines: () => req<AirlineInfo[]>("/airlines"),
  airports: (q: string, opts?: AirportSearchOpts) =>
    req<AirportInfo[]>(`/airports?${airportParams(q, opts)}`),
  airportCountries: () =>
    req<{ country: string; count: number }[]>("/airports/countries"),
  /** Exact lookup for codes you already hold, in one round trip. Not a search —
   *  see the note on the route. Codes with no matching row come back absent. */
  airportNames: (codes: string[]) =>
    req<AirportName[]>(`/airports/lookup?codes=${codes.join(",")}`),
  // Same criteria as `airports`, slim columns, much higher cap — the map plots
  // the whole matching set while the table lists only the top matches.
  airportsGeo: (q: string, opts?: AirportSearchOpts) =>
    req<AirportGeo[]>(`/airports/geo?${airportParams(q, opts)}`),
  trackedRoutes: () => req<TrackedRoute[]>("/tracked-routes"),
  addTrackedRoute: (body: RouteInput) =>
    req<{ id: number }>("/tracked-routes", { method: "POST", body: JSON.stringify(body) }),
  /** Edit a stored route. The Worker MERGES this against the stored row — an
   *  absent field is left alone, an empty array clears that filter — so a caller
   *  holding only part of a route can send only that part. The header's edit
   *  mode sends the whole thing. */
  updateTrackedRoute: (id: number, body: Partial<RouteInput>) =>
    req<{ ok: true }>(`/tracked-routes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTrackedRoute: (id: number) =>
    req<{ ok: true }>(`/tracked-routes/${id}`, { method: "DELETE" }),

  /** Search a route against seats.aero, on the Worker. A stream, so it is a bare
   *  generator rather than a `req` call — see `searchRoute`. */
  searchRoute,

  /**
   * Buy the real itinerary behind one summary find — one seats.aero call.
   *
   * No cabin: one availability id covers all four, so the call the user is
   * paying for expands every sibling row too and the response reports them all.
   */
  enrichFind: (body: {
    origin: string;
    destination: string;
    flightDate: string;
    program: string;
  }) => req<EnrichResult>("/finds/enrich", { method: "POST", body: JSON.stringify(body) }),

  /** Enrich a whole route's summary finds. A stream — see `enrichRoute`. */
  enrichRoute,

  /** Remaining daily API allowance per metered source. A display, not a guard —
   *  only `alerts/budget.ts` reads the quota before spending. */
  quota: () => req<QuotaPage>("/quota"),

  // ---- Alerts: the scheduled sweep ----
  // Read-only in production. The cron does the writing; the only way to change
  // what it does is to edit a route (`updateTrackedRoute`). See docs/ALERTS.md.
  alertSchedule: () => req<AlertSchedule>("/alerts/schedule"),
  /** Sweep runs — ordinary `search_runs` rows with `trigger='alert'`. */
  alertRuns: (limit = 25) => req<SearchRun[]>(`/alerts/runs?limit=${limit}`),
  alertDeliveries: (limit = 25) => req<AlertDelivery[]>(`/alerts/deliveries?limit=${limit}`),
  /**
   * Fire one tick by hand. **Local dev only** — 404s in production, which is why
   * every call site is behind `AlertSchedule.manualTick`.
   *
   * `routeId` sweeps that route whether or not it is due; omitting it replays
   * what the cron would do right now, which usually means sweeping nothing. Both
   * spend real seats.aero calls, hence the search-length timeout: a forced sweep
   * may make up to `budget.maxCallsPerTick` of them before answering.
   */
  alertRunTick: (routeId?: number) =>
    req<AlertTickResult>("/alerts/run", {
      method: "POST",
      body: JSON.stringify(routeId == null ? {} : { routeId }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }),
};
