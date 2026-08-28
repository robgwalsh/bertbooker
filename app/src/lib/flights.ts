// A flown segment as text and links: the display code, the FlightAware ident it
// resolves to, the carrier logo URL, and the defensive parse of a stored
// `segments_json` blob. Pure — `lib/flights.test.ts` covers the two that have
// genuinely surprising rules.

import { AIRLINE_ICAO } from "../data/airlineIcao";
import type { Segment } from "../api";

/** Square carrier logo by IATA code, from Kiwi's public image CDN.
 *
 *  Keyed on the code the segment already carries, so — unlike a hand-maintained
 *  domain→favicon map — a regional operator flying a single leg (Envoy, SkyWest,
 *  Republic) still gets a real mark. Unknown codes redirect to a generic plane
 *  tile rather than 404ing, so onError is a backstop for network failure rather
 *  than the normal miss path. */
export const airlineLogoUrl = (iata: string) =>
  `https://images.kiwi.com/airlines/64x64/${iata}.png`;

/**
 * A segment's display code, e.g. "AS 505".
 *
 * `flightNumber` is not normalized: seats.aero returns it carrier-prefixed
 * ("AA4457"), and sources this app has carried before returned bare digits
 * ("505"). Joining blindly gives "AA AA4457", so strip a leading copy of the
 * carrier before joining. Kept tolerant of both because the stored rows are.
 */
export function flightLabel(s: Segment): string {
  const carrier = (s.carrier ?? "").toUpperCase();
  const raw = (s.flightNumber ?? "").trim();
  const num =
    carrier && raw.toUpperCase().startsWith(carrier) ? raw.slice(carrier.length).trim() : raw;
  return [carrier, num].filter(Boolean).join(" ");
}

/**
 * FlightAware's page for a leg, or undefined when there is nothing to look up.
 *
 * Built off `flightLabel` so the link and the text it sits under can never
 * disagree about which flight this is — but the ident it links to is NOT the
 * label. FlightAware canonicalizes on the **ICAO** carrier code, so Delta's
 * DL5678 is its DAL5678; it does not resolve the IATA form for us, and the old
 * comment here claiming it did is why every Delta link was dead. `AIRLINE_ICAO`
 * is the translation, and adding a row is how a specific broken carrier gets
 * fixed.
 *
 * A carrier we don't map falls through to the IATA ident unchanged, which is
 * what the app did for everyone before: FlightAware answers some of those and
 * not others, so it is best effort rather than a promise. A three-character
 * carrier falls through too — nothing in this app emits one, but if a source
 * ever does it is already ICAO.
 *
 * Both halves are required. A carrier with no number is not a flight, and a
 * bare number with no carrier resolves to whichever airline FlightAware guesses
 * — a link to the wrong aeroplane is worse than no link.
 */
export function flightAwareUrl(s: Segment): string | undefined {
  const parts = flightLabel(s).split(" ");
  if (parts.length !== 2) return undefined;
  const [carrier = "", num = ""] = parts;
  const ident = `${AIRLINE_ICAO[carrier] ?? carrier}${num}`;
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(ident)) return undefined;
  return `https://www.flightaware.com/live/flight/${ident}`;
}

// Parse a stored segments_json blob defensively (never throws).
export function parseSegments(json?: string): Segment[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as Segment[]) : [];
  } catch {
    return [];
  }
}

/** A carrier serving a find's cabin, and whether it is one of the ones flying
 *  it nonstop. */
export interface CarrierMark {
  code: string;
  nonstop: boolean;
}

/** Parse one of the stored carrier blobs (`airlines`, `direct_airlines`)
 *  defensively (never throws). */
function parseCarriers(json?: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Every carrier competing for a find's cabin, nonstop operators first.
 *
 * `direct_airlines` is documented as a SUBSET of `airlines`
 * (`api/src/providers/seatsaero.ts`), and is one in every captured fixture. This
 * unions them anyway: the blobs are two independent columns, the union costs a
 * `Set`, and it degrades to the same answer when the subset property holds. A
 * filter would silently drop a nonstop carrier if it ever did not.
 *
 * Nonstop first because that is the ordering somebody scanning for "can I avoid
 * the connection" is reading for; alphabetical within each half so a row's marks
 * don't reshuffle between searches.
 *
 * `omit` drops carriers the caller already shows some other way — a drawn
 * itinerary names its own operators leg by leg, so repeating them below it says
 * nothing, and what is left is exactly the competition the card cannot show.
 */
export function carrierMarks(
  airlines?: string | null,
  directAirlines?: string | null,
  omit?: Iterable<string>,
): CarrierMark[] {
  const direct = new Set(parseCarriers(directAirlines));
  const all = new Set([...parseCarriers(airlines), ...direct]);
  for (const c of omit ?? []) all.delete(c);
  const sorted = [...all].sort();
  return [
    ...sorted.filter((c) => direct.has(c)).map((code) => ({ code, nonstop: true })),
    ...sorted.filter((c) => !direct.has(c)).map((code) => ({ code, nonstop: false })),
  ];
}
