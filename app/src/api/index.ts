// Thin typed fetch helpers against the API worker. Every path is relative and
// that is deliberate: in prod the same worker serves this bundle and answers
// /api/*, so there is no base URL to configure; in dev vite.config.ts proxies
// /api to :8787.
//
// ---- The wire contract ----
//
// **This file is the ONLY place in the SPA that names a path inside `api/`.**
// Everything else imports from `./api` and knows nothing about the boundary,
// which is why splitting this module into `api/` did not touch a single call
// site: `api.ts` became `api/index.ts` and the specifier is unchanged.
//
// The types below are declared in `api/src/models/wire/`, not here. There is one
// definition, and the Worker is annotated against it, so the two halves of a
// response cannot drift apart in silence.
//
// `api/src/models/wire/` is the ONLY thing under `api/src` the SPA may ever
// reach into. A path that climbs past it into the rest of `api/src` reaches
// `D1Database` and `fetch` and fails `tsc -p app` — loudly, but at the far end
// of whatever chain got it there. See the banner in
// `api/src/models/wire/index.ts`.
//
// Note every type line below is `export type`. `app/tsconfig.json` sets
// `isolatedModules`, so a bare `export { SomeType }` is an error — and the
// `import type` form is also what guarantees esbuild erases these entirely
// rather than emitting a runtime import of a module the browser never needs.

export type {
  // Envelopes and D1 row projections
  RoutesData,
  TrackedRoute,
  RouteInput,
  Find,
  Run,
  SourceQuota,
  QuotaPage,
  D1Usage,
  D1UsagePage,
  AlertDelivery,
  // The scheduled sweep
  AlertSchedule,
  AlertSchedulePacing,
  AlertScheduleBudget,
  AlertScheduleRoute,
  // The alert-recipient allowlist
  AlertRecipient,
  AlertRecipients,
  AlertRecipientInput,
  // Reference data
  ProgramInfo,
  CurrencyInfo,
  AirlineInfo,
  AirportInfo,
  AirportName,
  AirportGeo,
  // The seats.aero route graph
  RouteGraphSource,
  RouteFetchRecord,
  RouteFetchStatus,
  RouteFetchResult,
  RouteGraphRow,
  RouteGraphEdge,
  RouteGraphGeo,
  PairCoverage,
  PairProgram,
  PairPaths,
  PathDepth,
  PathLeg,
  PathSearchResult,
  GraphPath,
  PairReach,
  RouteReach,
  ReachReport,
  ReachVerdict,
  // Domain vocabulary
  SourceTaskStatus,
  RunStatus,
  ChangeSummary,
  Segment,
  AlertType,
  // Streams
  SearchEvent,
  EnrichEvent,
  // The gate
  SessionState,
  LoginResult,
  // Errors
  ApiErrorBody,
  ApiErrorCode,
} from "../../../api/src/models/wire/index.js";

// Renamed at the boundary. The wire spells these for the Worker that produces
// them; the SPA spells them for the screen that draws them. One definition
// either way, and the alias is where the two names meet.
export type {
  SeatsAeroCall as SearchCall,
  EnrichOutcome as EnrichResult,
  TickResult as AlertTickResult,
} from "../../../api/src/models/wire/index.js";

// The one VALUE crossing the boundary, and the reason this import is not
// `import type`. It is also the constant whose duplicate the confirm dialog used
// to quote.
export {
  ENRICH_MAX_PER_RUN,
  MAX_DESTINATIONS,
  MAX_ORIGINS,
  MAX_VIA,
  SEATSAERO_CHUNK_DAYS,
  SEATSAERO_MAX_CHUNKS,
  SEATSAERO_MAX_PAGES,
  SEATSAERO_SOURCE_ID,
} from "../../../api/src/models/wire/index.js";

export { ApiError } from "./client";
export type { AirportSearchOpts } from "./airports";
export type { RouteGraphOpts } from "./routeGraph";
export { searchRoute } from "./search";
export { enrichRoute } from "./enrich";

import { login, logout, session } from "./session";
import { airportCountries, airportNames, airports, airportsGeo } from "./airports";
import { airlines, currencies, d1Usage, programs, quota } from "./reference";
import {
  addTrackedRoute,
  deleteTrackedRoute,
  routes,
  suggestRoutePaths,
  trackedRoutes,
  updateTrackedRoute,
} from "./trackedRoutes";
import { searchRoute } from "./search";
import { enrichFind, enrichRoute } from "./enrich";
import { alertDeliveries, alertRunTick, alertRuns, alertSchedule } from "./alerts";
import {
  addAlertRecipient,
  alertRecipients,
  deleteAlertRecipient,
  setAlertAllowance,
} from "./settings";
import {
  fetchRouteGraph,
  routeGraph,
  routeGraphGeo,
  routeGraphPair,
  routeGraphPaths,
  routeGraphReach,
  routeGraphSources,
} from "./routeGraph";

/**
 * Every call the SPA can make, in one object.
 *
 * Kept as a single namespace rather than loose exports because it is what the
 * TanStack Query call sites read as (`queryFn: api.routes`), and because a
 * flat list of twenty-odd verbs is easier to scan for "is there already a call
 * for this" than twenty import statements would be.
 */
export const api = {
  // ---- The password gate (outside it, necessarily) ----
  session,
  login,
  logout,

  routes,
  programs,
  currencies,
  airlines,
  airports,
  airportCountries,
  airportNames,
  airportsGeo,
  trackedRoutes,
  addTrackedRoute,
  updateTrackedRoute,
  deleteTrackedRoute,

  /** Hubs the route graph would suggest for a route. Free, and writes
   *  nothing — the edit dialog fills its Via field with the answer. */
  suggestRoutePaths,

  /** Search a route against seats.aero, on the Worker. A stream, so it is a bare
   *  generator rather than a `req` call — see `searchRoute`. */
  searchRoute,

  enrichFind,

  /** Enrich a whole route's summary finds. A stream — see `enrichRoute`. */
  enrichRoute,

  quota,

  /** Today's D1 rows read and written against their ceilings. Free, and
   *  separate from `quota` so a slow answer from Cloudflare cannot delay the
   *  seats.aero number. */
  d1Usage,

  // ---- The seats.aero route graph (Library) ----
  routeGraphSources,
  routeGraph,
  routeGraphGeo,
  routeGraphPair,
  routeGraphPaths,
  routeGraphReach,

  /** **METERED** — one seats.aero call, replacing one source's stored graph.
   *  The only call on this page that spends anything. */
  fetchRouteGraph,

  // ---- Alerts: the scheduled sweep ----
  alertSchedule,
  alertRuns,
  alertDeliveries,
  alertRunTick,

  // ---- Settings: the addresses a digest may be sent to ----
  alertRecipients,
  addAlertRecipient,
  deleteAlertRecipient,
  setAlertAllowance,
};
