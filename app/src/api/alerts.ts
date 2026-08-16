// ---- Alerts: the scheduled sweep ----
// Read-only in production. The cron does the writing; the only way to change
// what it does is to edit a route (`updateTrackedRoute`). See docs/ALERTS.md.

import { req, SEARCH_TIMEOUT_MS } from "./client";
import type {
  AlertSchedule,
  SearchRun,
  AlertDelivery,
  TickResult,
} from "../../../shared/src/wire/index.js";

export const alertSchedule = () => req<AlertSchedule>("/alerts/schedule");

/** Sweep runs — ordinary `search_runs` rows with `trigger='alert'`. */
export const alertRuns = (limit = 25) => req<SearchRun[]>(`/alerts/runs?limit=${limit}`);

export const alertDeliveries = (limit = 25) =>
  req<AlertDelivery[]>(`/alerts/deliveries?limit=${limit}`);

/**
 * Fire one tick by hand. **Local dev only** — 404s in production, which is why
 * every call site is behind `AlertSchedule.manualTick`.
 *
 * `routeId` sweeps that route whether or not it is due; omitting it replays
 * what the cron would do right now, which usually means sweeping nothing. Both
 * spend real seats.aero calls, hence the search-length timeout: a forced sweep
 * may make up to `budget.maxCallsPerTick` of them before answering.
 */
export const alertRunTick = (routeId?: number) =>
  req<TickResult>("/alerts/run", {
    method: "POST",
    body: JSON.stringify(routeId == null ? {} : { routeId }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
