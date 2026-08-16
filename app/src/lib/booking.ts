// Where a find's "book" button points, and what a cash fare costs in points.
// Pure and JSX-free.

import type { Find } from "../api";

/**
 * The cheapest way to pay a CASH fare with points, across the currencies the
 * couple holds.
 *
 * Mirrors `bestPointsForCash` in shared/src/data/programs.ts, but reads
 * its rates from `api.currencies()` rather than a second hardcoded copy — so the
 * portal rate lives in exactly one place even though the conversion happens on
 * the client. Returns undefined when there's no fare or no portal rate.
 */
export function bestPortalPrice(
  cents: number | null | undefined,
  currencies: { code: string; portalCentsPerPoint?: number }[] | undefined,
): { code: string; points: number } | undefined {
  if (cents == null || !Number.isFinite(cents) || cents <= 0 || !currencies) return undefined;
  let best: { code: string; points: number } | undefined;
  for (const c of currencies) {
    if (!c.portalCentsPerPoint) continue;
    const points = Math.ceil(cents / c.portalCentsPerPoint);
    if (!best || points < best.points) best = { code: c.code, points };
  }
  return best;
}

// Google Flights search for a route + date — the fallback when a result has no
// airline booking link (e.g. summary-only results whose detail fetch failed).
export function flightSearchUrl(f: {
  origin: string;
  destination: string;
  flight_date: string;
}): string {
  const q = `Flights from ${f.origin} to ${f.destination} on ${f.flight_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

// Where a find's "book" button should point: the airline/program's own award
// page, when the source gave us one, else a Google Flights
// search. Returns the target URL plus a short label for the destination host.
export function bookingTarget(f: Find): { url: string; label: string; isAirline: boolean } {
  if (f.booking_url) {
    let host = "airline site";
    try {
      host = new URL(f.booking_url).hostname.replace(/^www\./, "");
    } catch {
      /* keep fallback label */
    }
    return { url: f.booking_url, label: `Book on ${host}`, isAirline: true };
  }
  return { url: flightSearchUrl(f), label: "Search on Google Flights", isAirline: false };
}
