import type { Find, TrackedRoute } from "../api";
import { parseSegments } from "./flights";
import { layoverMinutes } from "./format";
import { collapseLegs } from "./roundtrip";
import { addDaysISO, parseCodeList, routeSets } from "./routeShape";

/**
 * Joining two stored one-way finds into one journey through a hub.
 *
 * READ-TIME ONLY, exactly as `roundtrip.ts` is, and for the same reason: nothing
 * here gathers, stores or prices anything. It answers a question the one-way
 * table cannot — *which stored leg into a hub joins which stored leg out of it* —
 * for a pair seats.aero holds no market on at all. SFO->KTM is in no program's
 * graph and comes back empty from every search forever; SFO->ICN and ICN->KTM
 * are ordinary markets, and once both are tracked the answer is already sitting
 * in the dashboard payload with nothing to join it.
 *
 * **Three things this produces are claims the data does not make**, and every
 * surface rendering them owes the reader all three:
 *
 *  - `totalMiles` is AN ADDITION WE DID. Two legs is two separate award
 *    bookings, never one fare — the same caveat `roundtrip.ts` carries, except a
 *    round trip's halves are weeks apart and these are hours.
 *  - **The connection is not protected.** Nobody rebooks you when leg one is
 *    late, and when the legs are in different programs it is two tickets in two
 *    currencies that cannot ever become one. That is what `mixed` is for.
 *  - **The ground time is usually unknown.** A summary row carries no times at
 *    all, so `gapMinutes` is null far more often than not, and null means
 *    *unknown* rather than *tight*.
 *
 * Hubs are DISCOVERED, never configured: any airport a stored leg lands at and
 * another stored leg departs from. So the feature turns itself on the moment the
 * Tools page's "Track these legs" button has done its job, and needs no column,
 * no migration and no metered call.
 *
 * Pure and dependency-free (no React, no MUI) so the test loads nothing heavy.
 */

/** Legs may be this many days apart. `0` is a same-day connection and `1` an
 *  overnight in the hub — which for ICN, DOH or IST is routinely the only
 *  realistic option, and no more verifiable than the same-day one. */
export const DEFAULT_MAX_CONNECT_DAYS = 1;

/** Backstop on whatever reaches `stitchJourneys`, the way `MAX_WINDOW_NIGHTS`
 *  bounds the nights loop. A week in the hub is a stopover someone planned, not
 *  a connection this table should be inventing. */
export const MAX_CONNECT_DAYS = 7;

const DEFAULT_LIMIT = 200;

/** One flown leg of a journey, and the gap before it. */
export interface JourneyLeg {
  find: Find;
  /**
   * Minutes on the ground at this leg's origin, or `null` for **unknown**.
   *
   * Null whenever either side lacks a time, which is every unenriched leg. Both
   * times are local to the hub — the same airport — so subtracting them is the
   * one place `layoverMinutes` can be trusted across two separate itineraries.
   * Always null on the first leg, which has no gap before it.
   */
  gapMinutes: number | null;
}

/** Two stored one-ways, joined at a hub. */
export interface Journey {
  legs: JourneyLeg[];
  /** The hubs, in order — `legs.length - 1` of them. */
  via: string[];
  /** Calendar days between the legs' departure dates. 0 = same day. */
  connectDays: number;
  /** A SUM OF SEPARATE ONE-WAY AWARDS, not a fare. */
  totalMiles: number;
  /** Only a total when `feesCurrency` is non-null — see it. */
  totalFeesCents: number;
  /**
   * The currency every leg's taxes are charged in, or **null when they differ**.
   *
   * Not decoration. seats.aero quotes Aeroplan in CAD and Korean Air out of
   * Seoul in KRW, so a real SFO→ICN→KTM journey adds 560 USD cents to 2,400,000
   * KRW — and the sum is a number with no meaning at all, which rendered as
   * dollars reads as $24,029.90 for about $1,700 of tax. When this is null the
   * total must not be shown; the legs' own figures must.
   */
  feesCurrency: string | null;
  /** The LOWEST leg's — a journey needs seats on every leg. */
  seats: number;
  /** Distinct programs, in leg order. */
  programs: string[];
  /**
   * More than one program flies this journey's legs.
   *
   * Two award tickets in two currencies, which can never become one booking.
   * Ranked by price alongside the rest rather than demoted — a cheaper mixed
   * journey is still the cheapest way there, and hiding it is the failure this
   * app exists to avoid — but never drawn as equivalent.
   */
  mixed: boolean;
}

export interface JourneyResult {
  journeys: Journey[];
  /** Passed the filter BEFORE the limit. */
  considered: number;
  truncated: boolean;
  /** Hubs that had legs on both sides. Lets an empty result say whether nothing
   *  connects or nothing was stored to connect. */
  hubs: string[];
  inboundSlots: number;
  outboundSlots: number;
}

export interface StitchOptions {
  maxConnectDays?: number;
  limit?: number;
}

/**
 * Which combinations of a stored leg into a hub and a stored leg out of it make
 * a journey.
 *
 * Pure and total; neither input is mutated. The rules:
 *
 *  - **`second.origin === first.destination`** — you continue from where you
 *    landed. The same rule that stops `pairRoundTrips` inventing open jaws.
 *  - **A hub is never an endpoint.** An airport already on either side of the
 *    route is a leg of the route, not a connection through it, and treating one
 *    as a hub would offer SFO->SFO->KTM.
 *  - **Cabin is NOT part of the join**, which is the one deliberate difference
 *    from round-trip pairing. Economy to the hub and business long-haul is the
 *    ordinary award shape, and requiring a match would hide the cheap half of
 *    most journeys. The route's own cabin filter still binds each leg.
 *  - **Programs MAY differ**, and `mixed` records it.
 *  - **The route's own filters apply to both legs**, because the legs were
 *    cleared by whichever OTHER route gathered them. Without this a route
 *    filtered to business could show an economy leg it excludes.
 *
 * `finds` is the whole dashboard payload rather than one route's slice: the legs
 * belong to other tracked routes by construction, which is the entire premise.
 */
export function stitchJourneys(
  route: TrackedRoute,
  finds: readonly Find[],
  opts: StitchOptions = {},
): JourneyResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxConnectDays = clamp(opts.maxConnectDays ?? DEFAULT_MAX_CONNECT_DAYS, 0, MAX_CONNECT_DAYS);

  const { origins, destinations } = routeSets(route);
  const from = new Set(origins);
  const to = new Set(destinations);
  const endpoint = (code: string): boolean => from.has(code) || to.has(code);

  // The route's OWN hubs, when it has them, and anything that connects when it
  // does not.
  //
  // A route with `via` set is monitoring exactly those hubs — its search asks
  // for them by name — so stitching through some other airport would offer a
  // journey out of legs nobody is keeping current. A route WITHOUT `via` still
  // discovers them, because that is how this worked before hubs were a column
  // and how it still works for anyone holding a leg as its own tracked route.
  const declared = new Set(parseCodeList(route.via));
  const isHub = (code: string): boolean =>
    !endpoint(code) && (declared.size === 0 || declared.has(code));

  const allows = legFilter(route);
  // Leg two may depart the day after the window closes: an overnight on the last
  // gathered date is a real journey, and clipping it would drop the answer at
  // exactly the edge the user asked about.
  const lastDate = addDaysISO(route.date_end, maxConnectDays);

  const first: Find[] = [];
  const second: Find[] = [];
  for (const f of finds) {
    if (!allows(f)) continue;
    if (from.has(f.origin) && isHub(f.destination) && withinDates(f, route.date_start, route.date_end)) {
      first.push(f);
    }
    if (to.has(f.destination) && isHub(f.origin) && withinDates(f, route.date_start, lastDate)) {
      second.push(f);
    }
  }

  const out = collapseLegs(first);
  const back = collapseLegs(second);

  // Keyed on the second leg's departure airport and date — everything a
  // candidate must match. Cabin is deliberately absent (see the rules above), so
  // one lookup yields every onward leg that day whatever cabin it is in.
  const index = new Map<string, Find[]>();
  for (const f of back) {
    const k = `${f.origin}|${f.flight_date}`;
    const arr = index.get(k);
    if (arr) arr.push(f);
    else index.set(k, [f]);
  }

  const journeys: Journey[] = [];
  const hubs = new Set<string>();
  for (const a of out) {
    for (let d = 0; d <= maxConnectDays; d++) {
      const candidates = index.get(`${a.destination}|${addDaysISO(a.flight_date, d)}`);
      if (!candidates) continue;
      for (const b of candidates) {
        hubs.add(a.destination);
        const programs = a.program === b.program ? [a.program] : [a.program, b.program];
        const currency = sharedFeesCurrency([a, b]);
        journeys.push({
          legs: [
            { find: a, gapMinutes: null },
            { find: b, gapMinutes: groundMinutes(a, b) },
          ],
          via: [a.destination],
          connectDays: d,
          totalMiles: a.miles_cost + b.miles_cost,
          totalFeesCents: a.cash_fees_cents + b.cash_fees_cents,
          feesCurrency: currency,
          seats: Math.min(a.seats_available, b.seats_available),
          programs,
          mixed: programs.length > 1,
        });
      }
    }
  }

  const considered = journeys.length;
  journeys.sort((x, y) => x.totalMiles - y.totalMiles || x.connectDays - y.connectDays);
  return {
    journeys: journeys.slice(0, limit),
    considered,
    truncated: considered > limit,
    hubs: [...hubs].sort(),
    outboundSlots: out.length,
    inboundSlots: back.length,
  };
}

// --- the route's own filters, applied to a leg it did not gather -------------

/**
 * A route's finds, split into the ones it is NAMED for and the legs it monitors
 * on the way.
 *
 * `ROUTE_FINDS_MATCH` returns both under one route now, which is what makes a
 * journey possible without a second request — but a leg is not an answer to the
 * question the route asks. SFO->ICN under a route to KTM is a row that looks
 * like a find and is half of one, and listing it beside the direct results is
 * exactly the rail-full-of-fragments problem hubs were meant to end.
 *
 * Pure, and total: anything matching neither pattern (a stale row from a hub
 * since removed) lands in `legs`, where the stitcher will simply not join it.
 */
export function splitDirectAndLegs(
  route: TrackedRoute,
  finds: readonly Find[],
): { direct: Find[]; legs: Find[] } {
  const { origins, destinations } = routeSets(route);
  const from = new Set(origins);
  const to = new Set(destinations);
  const direct: Find[] = [];
  const legs: Find[] = [];
  for (const f of finds) {
    // A round trip's return leg is direct too — it is the route's own pair,
    // reversed, and `ROUTE_FINDS_MATCH` returns it for exactly that reason.
    const isDirect =
      (from.has(f.origin) && to.has(f.destination)) ||
      (route.round_trip === 1 && to.has(f.origin) && from.has(f.destination));
    (isDirect ? direct : legs).push(f);
  }
  return { direct, legs };
}

/**
 * The route's filters, as a predicate over any find.
 *
 * `ROUTE_FINDS_MATCH` (`api/src/db/finds.ts`) already applied each route's
 * filters to its OWN finds server-side. A journey borrows legs from other
 * routes, so those filters have to be applied again here or a route filtered to
 * business could be shown an economy leg.
 *
 * **The currency clause is the one approximation, and it is deliberate.** The
 * SQL's third branch is "a known cash fare is bookable through any card's travel
 * portal, if the route's currencies include a portal one" — and the portal list
 * lives in `api/src/domain/programs.ts`, which the SPA cannot import. Rebuilding
 * it here would be a second copy of a rule that has already drifted once (see
 * `bookableCurrencies` in CLAUDE.md), so a known cash fare passes outright. The
 * error that leaves is over-inclusive, which is the safe direction: this app's
 * standing bias is against hiding a bookable seat.
 */
function legFilter(route: TrackedRoute): (f: Find) => boolean {
  const cabins = new Set(parseCodeList(route.cabins));
  const currencies = new Set(parseCodeList(route.currencies));
  return (f: Find): boolean => {
    if (f.seats_available < route.min_seats) return false;
    if (cabins.size && !cabins.has(f.cabin)) return false;
    if (!currencies.size) return true;
    if (f.cash_price_cents != null) return true;
    return parseCodeList(f.transfer_currencies).some((c) => currencies.has(c));
  };
}

/** The one currency every leg's taxes are in, or null when they disagree. A leg
 *  with no stated currency is read as USD, which is the column's own default. */
function sharedFeesCurrency(legs: readonly Find[]): string | null {
  const codes = new Set(legs.map((l) => (l.fees_currency ?? "USD").toUpperCase()));
  return codes.size === 1 ? [...codes][0]! : null;
}

const withinDates = (f: Find, start: string, end: string): boolean =>
  f.flight_date >= start && f.flight_date <= end;

/**
 * Minutes on the ground between two separate itineraries.
 *
 * Both timestamps are LOCAL to the hub with no offset attached — the same
 * airport — which is the one case where subtracting two of `format.ts`'s
 * unparsed local times is sound. `layoverMinutes` already answers `null` for a
 * missing side or a non-positive gap, and null must read as *unknown*: a summary
 * row carries no times at all and guessing one would invent a connection.
 */
function groundMinutes(first: Find, second: Find): number | null {
  const arrives = parseSegments(first.segments_json).at(-1)?.arrivesAt;
  const departs = parseSegments(second.segments_json)[0]?.departsAt;
  return layoverMinutes(arrives, departs);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.round(n), lo), hi);
}
