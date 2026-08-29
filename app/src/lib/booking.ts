// Where a find's "book" button points. Pure and JSX-free.

import type { Find } from "../api";

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
  // The URL is parsed for the label anyway, so checking its scheme with the same
  // parse is free — and it is the difference between "this app validated the
  // link" and "React happens to refuse javascript: hrefs". The provider now
  // declines to STORE a non-https link (api/src/providers/seatsaero.ts), which is
  // where the check belongs; this is the belt, because rows written before that
  // check existed are still in the database, and this is the last point before
  // the value becomes an `href`.
  //
  // Anything not https falls through to the search link rather than rendering a
  // dead Book button: the row is still a real find, and the fallback is exactly
  // what a find with no link at all already gets.
  if (f.booking_url) {
    try {
      const parsed = new URL(f.booking_url);
      if (parsed.protocol === "https:") {
        return {
          url: f.booking_url,
          label: `Book on ${parsed.hostname.replace(/^www\./, "")}`,
          isAirline: true,
        };
      }
    } catch {
      /* fall through to the search link */
    }
  }
  return { url: flightSearchUrl(f), label: "Search on Google Flights", isAirline: false };
}
