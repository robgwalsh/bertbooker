// Thin typed fetch helpers against the API worker. Every path is relative and
// that is deliberate: in prod the same worker serves this bundle and answers
// /api/*, so there is no base URL to configure; in dev vite.config.ts proxies
// /api to :8787.
//
// ---- The wire contract ----
//
// **This file is the ONLY place in the SPA that names a path inside `shared/`.**
// Everything else imports from `./api` and knows nothing about the boundary,
// which is why splitting this module into `api/` did not touch a single call
// site: `api.ts` became `api/index.ts` and the specifier is unchanged.
//
// The types below used to be declared here, hand-mirrored out of `api/src` and
// `shared/`, with a banner explaining that the SPA could not import them. It
// also recorded what that cost: `PRIMARY_METERED_SOURCE` sat on a stale source
// id for months after a migration renamed it, and every quota lookup silently
// matched nothing. **That incident is why `shared/src/wire/` exists.** There is
// one definition now, and the Worker is annotated against it, so the two halves
// of a response cannot drift apart in silence.
//
// NEVER import `shared/src/index.js` from here. It re-exports `ingest/apply.ts`,
// which names `D1Database` at module scope, and `tsc -p app` has no
// `@cloudflare/workers-types` — it fails outright. `shared/src/sources/index.js`
// is out too: it calls `registerSource()` as a top-level side effect. The
// banner in `shared/src/wire/index.ts` has the full list and the reasons.
//
// Note every type line below is `export type`. `app/tsconfig.json` sets
// `isolatedModules`, so a bare `export { SomeType }` is an error — and the
// `import type` form is also what guarantees esbuild erases these entirely
// rather than emitting a runtime import of a module the browser never needs.

export type {
  // Envelopes and D1 row projections
  DashboardData,
  TrackedRoute,
  RouteInput,
  Find,
  SearchRun,
  SourceQuota,
  QuotaPage,
  AlertDelivery,
  // The scheduled sweep
  AlertSchedule,
  AlertSchedulePacing,
  AlertScheduleBudget,
  AlertScheduleRoute,
  // Reference data
  ProgramInfo,
  CurrencyInfo,
  AirlineInfo,
  AirportInfo,
  AirportName,
  AirportGeo,
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
} from "../../../shared/src/wire/index.js";

// Renamed at the boundary. The wire spells these for the Worker that produces
// them; the SPA spells them for the screen that draws them. One definition
// either way, and the alias is where the two names meet.
export type {
  SeatsAeroCall as SearchCall,
  EnrichOutcome as EnrichResult,
  TickResult as AlertTickResult,
} from "../../../shared/src/wire/index.js";

// The one VALUE crossing the boundary, and the reason this import is not
// `import type`. It is also the constant whose duplicate the confirm dialog used
// to quote.
export {
  ENRICH_MAX_PER_RUN,
  MAX_DESTINATIONS,
  MAX_ORIGINS,
  SEATSAERO_CHUNK_DAYS,
  SEATSAERO_MAX_CHUNKS,
  SEATSAERO_MAX_PAGES,
  SEATSAERO_SOURCE_ID,
} from "../../../shared/src/wire/index.js";

export { ApiError } from "./client";
export type { AirportSearchOpts } from "./airports";
export { searchRoute } from "./search";
export { enrichRoute } from "./enrich";

import { login, logout, session } from "./session";
import { airportCountries, airportNames, airports, airportsGeo } from "./airports";
import { airlines, currencies, programs, quota } from "./reference";
import {
  addTrackedRoute,
  dashboard,
  deleteTrackedRoute,
  trackedRoutes,
  updateTrackedRoute,
} from "./trackedRoutes";
import { searchRoute } from "./search";
import { enrichFind, enrichRoute } from "./enrich";
import { alertDeliveries, alertRunTick, alertRuns, alertSchedule } from "./alerts";

/**
 * Every call the SPA can make, in one object.
 *
 * Kept as a single namespace rather than loose exports because it is what the
 * TanStack Query call sites read as (`queryFn: api.dashboard`), and because a
 * flat list of twenty-odd verbs is easier to scan for "is there already a call
 * for this" than twenty import statements would be.
 */
export const api = {
  // ---- The password gate (outside it, necessarily) ----
  session,
  login,
  logout,

  dashboard,
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

  /** Search a route against seats.aero, on the Worker. A stream, so it is a bare
   *  generator rather than a `req` call — see `searchRoute`. */
  searchRoute,

  enrichFind,

  /** Enrich a whole route's summary finds. A stream — see `enrichRoute`. */
  enrichRoute,

  quota,

  // ---- Alerts: the scheduled sweep ----
  alertSchedule,
  alertRuns,
  alertDeliveries,
  alertRunTick,
};
