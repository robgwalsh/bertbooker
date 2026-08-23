// How a route and its airports become words. Pure — the components that draw
// them are elsewhere in this directory.
//
// Two ladders live here and they answer different questions. `sideLabel` and
// `citySideLabel` both render one side of a route, in codes and in cities
// respectively, and deliberately share the slash form so the rail's two lines
// read as the same sentence twice.

import { parseCodes } from "../../lib/routeShape";
import { sinceLabel } from "../../lib/format";
import type { AirportName, TrackedRoute } from "../../api";

/** One side of a route: `SEA` or `SEA/PDX`. Falls back to the scalar, which for
 *  a route carrying no array IS the whole set. */
export function sideLabel(json: string | null, fallback: string): string {
  if (json) {
    try {
      const codes = JSON.parse(json);
      if (Array.isArray(codes) && codes.length) return codes.join("/");
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** "San Francisco International Airport · San Francisco, US", as much of it as
 *  we actually know. */
export function airportLine(a: AirportName | undefined, code: string): string {
  if (!a) return code;
  const where = [a.city, a.country].filter(Boolean).join(", ");
  return where ? `${a.name} · ${where}` : a.name;
}

/** The city behind a code, for the rail's one-line `Seattle/Portland → Tokyo`.
 *  Falls back to the code, which is never wrong — an unknown code is one the
 *  airports table has no row for. */
export function cityLabel(a: AirportName | undefined, code: string): string {
  return a?.city || a?.name || code;
}

/** One side of a route in cities rather than codes: `Seattle/Portland`. Same
 *  slash form as `sideLabel`, so the two lines read as the same sentence twice. */
export function citySideLabel(
  json: string | null,
  fallback: string,
  names: Map<string, AirportName>,
): string {
  return parseCodes(json, fallback)
    .map((c) => cityLabel(names.get(c), c))
    .join("/");
}

/** Inclusive day count of a route's window, for the header's "365 days". */
export function dayCount(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) + 1 : 0;
}

/**
 * Which way a route is drawn, everywhere it is drawn as text.
 *
 * `⇄` is not decoration: a round-trip route gathers and shows the reverse pair
 * too, so drawing it with a one-way arrow states the wrong thing about what the
 * route contains. Shared by the rail and the delete/enrich confirmations so they
 * cannot disagree.
 */
export function directionArrow(r: TrackedRoute): string {
  return r.round_trip === 1 ? "⇄" : "→";
}

/**
 * How long ago this route was actually looked at: `Searched 2h ago`.
 *
 * ONE clock answers this for both of the things that search, and that is the
 * point rather than a simplification. `last_checked_at` is stamped by
 * `api/src/search/run.ts`, which the Search button and the scheduled alert
 * sweep both go through — so a route the cron re-searched at 3am reads as
 * fresh here without anyone having to ask which of the two did it.
 */
export function searchedLabel(route: TrackedRoute): string {
  return route.last_checked_at
    ? `Searched ${sinceLabel(route.last_checked_at)}`
    : "Never searched";
}

/**
 * The sentence behind that value, and the two facts it has to carry.
 *
 * **The clock only moves on a search that claimed coverage.** A run whose every
 * task failed leaves `last_checked_at` alone, because "we looked" would be a
 * lie about a window nothing was stored for. So the complement is quoted too:
 * `alert_last_attempt_at` is stamped on every sweep ATTEMPT, before anything
 * can fail, which makes the pair legible in the one case that matters — a route
 * the sweep keeps trying and keeps failing reads as an old search beside a
 * recent attempt, instead of looking simply forgotten.
 *
 * `toLocaleString` is safe on these two and on nothing else in this directory:
 * they are epoch milliseconds — real instants — not the bare local `YYYY-MM-DD`
 * a route's window is made of. See the header of `lib/format.ts`.
 */
export function searchedHelp(route: TrackedRoute): string {
  const swept =
    route.alerts_enabled === 1 && route.alert_last_attempt_at
      ? ` The scheduled sweep last tried ${sinceLabel(route.alert_last_attempt_at)}.`
      : "";
  if (!route.last_checked_at) {
    return `Nothing has ever searched this window, so nothing is stored for it.${swept}`;
  }
  return (
    `Last searched ${new Date(route.last_checked_at).toLocaleString()} — by the Search ` +
    `button or by the scheduled sweep, which run the same engine and stamp the same ` +
    `clock. A search that fails outright doesn't move it.${swept}`
  );
}
