// Domain types that are ALREADY canonical elsewhere in `shared/`, re-exported
// here so the SPA reads them without knowing where in the domain they live.
//
// Every line below is `export type`, so esbuild erases this module entirely and
// the SPA pays nothing for it — which is what lets `data/programs.ts` (312
// lines) and `diff.ts` supply types to a browser bundle that never contains
// them.
//
// **The deep paths are load-bearing.** `../ingest/types.js`, never
// `../ingest/index.js`: the latter re-exports `apply.ts`, which names
// `D1Database` at module scope, and `tsc -p app` has no `@cloudflare/workers-types`.
// `shared/tsconfig.wire.json` is what enforces that, and it fails on the barrel.

export type { Cabin, Segment } from "../types.js";
export type { ChangeType, ChangeSummary } from "../diff.js";
export type { SourceTaskStatus, RunStatus } from "../ingest/types.js";
export type { RoutePair, RouteSpec } from "../routing.js";
// Values, not types: the route form offers at most this many airports a side,
// and the Worker refuses more with a 400 `bad_route_spec`. The SPA held its own
// copies of both numbers for as long as it could not import them.
export { MAX_DESTINATIONS, MAX_ORIGINS } from "../routing.js";
export type { SweepPacing } from "../alerts/pace.js";
export type { CurrencyInfo } from "../data/programs.js";
export type { AirlineInfo } from "../data/airlines.js";

import type { ChangeType } from "../diff.js";

/**
 * The four transitions an alert can fire on.
 *
 * Structurally `ChangeType` — the thing `diffAvailability` classifies — under
 * the name the wire and the SPA use for it. Note that the *display order* is NOT
 * here: `ALL_ALERT_TYPES` in `../alerts/select.js` and the SPA's `ALERT_TYPES`
 * list the same four members in different orders, and the SPA's order is what
 * the route form's checkboxes render in. Unifying the arrays would silently
 * reorder that form, so only the type is shared.
 */
export type AlertType = ChangeType;
