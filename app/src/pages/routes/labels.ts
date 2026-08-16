// How a route and its airports become words. Pure — the components that draw
// them are elsewhere in this directory.
//
// Two ladders live here and they answer different questions. `sideLabel` and
// `citySideLabel` both render one side of a route, in codes and in cities
// respectively, and deliberately share the slash form so the rail's two lines
// read as the same sentence twice.

import { parseCodes } from "../../lib/routeShape";
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
