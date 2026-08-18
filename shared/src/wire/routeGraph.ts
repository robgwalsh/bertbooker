// The seats.aero ROUTE GRAPH — which city pairs a mileage program's award
// inventory is monitored on. Read by the Worker that produces it and the
// Library's seats.aero pane that consumes it.
//
// This is reference data about the SOURCE'S OWN NETWORK, and it is known without
// searching anything. Nothing here is a find, and none of it claims search
// coverage — see the note on `PairReach` for why that distinction is worth
// keeping in the vocabulary.

/**
 * What a source said the last time we asked for its graph.
 *
 * `empty` is not a failure and must never render as one. seats.aero answers
 * `200 []` for a source name it does not recognise, so this is the outcome that
 * says "that name isn't real" — the single most useful thing this whole surface
 * reports, and the reason the fetch record is stored at all.
 */
export type RouteFetchStatus = "ok" | "empty" | "failed";

/** migrations/0003_seatsaero_routes.sql — seatsaero_route_fetches, one row per
 *  source we have asked. Asserted about by `readFetchRecords` in
 *  `api/src/db/routeGraph.ts`. */
export interface RouteFetchRecord {
  source: string;
  status: RouteFetchStatus;
  route_count: number;
  duplicate_rows: number;
  malformed_rows: number;
  fetched_at: number;
  duration_ms: number | null;
  http_status: number | null;
  bytes: number | null;
  error: string | null;
}

/**
 * A seats.aero source, what we know about it, and whether we have its graph.
 *
 * `program` is null for the sources seats.aero really has and this app
 * deliberately does not store — none of them is reachable from a currency the
 * couple holds. They are listed anyway: seeing that Smiles flies a pair nobody
 * else does is worth knowing even when it cannot be booked from here.
 */
export interface RouteGraphSource {
  /** seats.aero's own `Source` value — the key side of SEATSAERO_PROGRAM_MAP. */
  source: string;
  /** Our `programs.code`, or null when this source maps to no stored program. */
  program: string | null;
  /** The program's display name, or the bare source key when there is none. */
  label: string;
  alliance: string | null;
  /** Which of the couple's currencies can reach this program. Empty is a real
   *  answer (SkyMiles takes none of them), not a missing one. */
  currencies: string[];
  /** True for names this repo has already confirmed return `200 []`. Shown so
   *  the pane can offer them as the demonstration of what `empty` means. */
  knownEmpty: boolean;
  /** The last fetch, or null when this source has never been asked. That
   *  difference is the whole point — see `RouteFetchStatus`. */
  fetch: RouteFetchRecord | null;
}

/** POST /api/seatsaero/sources/:source/fetch — what one metered call bought. */
export interface RouteFetchResult {
  record: RouteFetchRecord;
  /** Calls left today, read off the response's own rate-limit header. Null when
   *  the header was absent or unparseable — never a fabricated number. */
  quotaRemaining: number | null;
}

/** migrations/0003_seatsaero_routes.sql — one row of seatsaero_routes, joined to
 *  `airports` for the names. Asserted about by the SELECT in
 *  `api/src/endpoints/seatsaeroRoutes.ts`'s table route. */
export interface RouteGraphRow {
  source: string;
  origin: string;
  destination: string;
  origin_region: string | null;
  destination_region: string | null;
  /** Statute miles. Zero occurs in the payload and means nothing useful. */
  distance_mi: number | null;
  origin_name: string | null;
  origin_city: string | null;
  destination_name: string | null;
  destination_city: string | null;
}

/** A drawable edge: a pair plus both ends' coordinates. Rows whose airports are
 *  unknown to the `airports` table arrive with null coordinates and are dropped
 *  by the map rather than plotted at null island. */
export interface RouteGraphEdge {
  origin: string;
  destination: string;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
}

/** GET /api/seatsaero/routes/geo. `truncated` is stated rather than silent: a
 *  route graph drawn short reads as a program that flies fewer places, which is
 *  a lie a map has no other way to correct. */
export interface RouteGraphGeo {
  edges: RouteGraphEdge[];
  total: number;
  truncated: boolean;
}

/** One program that flies a looked-up pair. */
export interface PairProgram {
  source: string;
  program: string | null;
  label: string;
  currencies: string[];
  distance_mi: number | null;
}

/** GET /api/seatsaero/routes/pair — both directions, because a program flying
 *  one way is not evidence about the other and the caller should see which. */
export interface PairCoverage {
  origin: string;
  destination: string;
  forward: PairProgram[];
  reverse: PairProgram[];
  /** Sources with a stored graph. A `gap` means nothing here — see
   *  `ReachVerdict` — unless this is non-empty. */
  fetchedSources: string[];
}

/**
 * Whether anyone's graph contains a pair.
 *
 * **Not "coverage".** `search_coverage` already means *did anyone look at
 * (route, date, program), and when* — a stored fact about our own searching,
 * which licenses a prune. This is a fact about the SOURCE'S network, true
 * whether or not we ever searched. Keeping the two words apart is what stops a
 * future reader treating one as the other.
 *
 * - `ok`      — at least one fetched source flies this pair.
 * - `gap`     — sources have been fetched, and none of them flies it. A search
 *               here will come back honestly empty, forever.
 * - `unknown` — nothing has been fetched, so there is nothing to conclude.
 */
export type ReachVerdict = "ok" | "gap" | "unknown";

export interface PairReach {
  origin: string;
  destination: string;
  verdict: ReachVerdict;
  /** `programs.code` values whose graph holds this pair. */
  programs: string[];
  /** Sources that hold it but map to no stored program — real reach this app
   *  cannot book, which is worth seeing rather than hiding. */
  unmappedSources: string[];
}

/** One tracked route's verdict, rolled up from its pairs. */
export interface RouteReach {
  routeId: number;
  origin: string;
  destination: string;
  roundTrip: boolean;
  /** The worst pair's verdict: a route with one unflown pair is not "ok", it is
   *  a route with a named hole, and an average would hide exactly that. */
  verdict: ReachVerdict;
  pairs: PairReach[];
}

/** GET /api/seatsaero/reach. The envelope carries the fetched-source count so
 *  the pane can qualify a `gap` honestly — "no fetched program flies this
 *  (6 of 26 fetched)" rather than "nobody flies this". */
export interface ReachReport {
  fetchedSources: number;
  totalSources: number;
  routes: RouteReach[];
}
