import type { Find } from "../../api";
import type { Journey } from "../../lib/multiLeg";
import type { RoundTripPair } from "../../lib/roundtrip";

// React keys for the two finds tables.
//
// Pure and DOM-free (type-only imports), like `roundtrip.ts` and
// `preferences.ts` beside it, because the web workspace runs vitest in Node.
//
// These exist as functions rather than inline template literals because each
// table now renders TWICE — a row on a desktop, a card on a phone — and an
// inline key would be four copies of one expression. A key that drifts between
// the two does not throw; it silently reuses the wrong element when the viewport
// crosses the breakpoint, which is the kind of bug that gets blamed on the
// browser.

/**
 * One find's key.
 *
 * `index` is in it and has to be. (route, date, program, cabin) is the SNAPSHOT
 * table's key but not necessarily this list's — `findsCte` collapses across
 * sources at query time and can hand back two sources' answers for one slot. It
 * is the *paginated* index (`start + i`), so the same find on
 * page 1 and page 3 is two different elements rather than one that appears to
 * move.
 */
export function findKey(f: Find, index: number): string {
  return [f.origin, f.destination, f.flight_date, f.program, f.cabin, index].join("|");
}

/**
 * One round-trip pair's key.
 *
 * Both legs, because a pair is only identified by both: the same outbound is in
 * as many pairs as there are returns that match it, and keying on the outbound
 * alone would collapse a whole night range into one row.
 */
export function pairKey(p: RoundTripPair, index: number): string {
  return [
    p.outbound.origin,
    p.outbound.destination,
    p.outbound.flight_date,
    p.outbound.program,
    p.inbound.origin,
    p.inbound.destination,
    p.inbound.flight_date,
    p.inbound.program,
    p.cabin,
    index,
  ].join("|");
}

/**
 * One multi-leg journey's key.
 *
 * Every leg, for the reason `pairKey` names both: one leg into a hub joins as
 * many journeys as there are legs out of it, and keying on the first alone would
 * collapse a whole hub's worth of options into one row. The cabin is per leg
 * here rather than per journey, so it rides along inside each leg's segment
 * instead of once at the end.
 */
export function journeyKey(j: Journey, index: number): string {
  return [
    ...j.legs.flatMap(({ find: f }) => [
      f.origin,
      f.destination,
      f.flight_date,
      f.program,
      f.cabin,
    ]),
    index,
  ].join("|");
}
