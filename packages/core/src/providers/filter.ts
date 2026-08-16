import type { AvailabilityResult, Currency, SearchParams } from "../types.js";
import { PORTAL_CURRENCIES } from "../data/programs.js";

/**
 * Every currency that can actually pay for this result — by transferring miles
 * to its program, OR by buying the same seat's cash fare through a card's travel
 * portal.
 *
 * The second half matters more than it looks: a program the couple can't
 * transfer to (Alaska takes Bilt only; Delta effectively takes nothing they
 * hold) still yields a bookable flight when a source could see its revenue fare.
 * Filtering on transfer partners alone would hide exactly the results this app
 * added cash pricing to surface.
 */
export function bookableCurrencies(r: AvailabilityResult): Currency[] {
  if (r.cashPriceCents == null) return r.bookableWith ?? [];
  const out = new Set<Currency>(r.bookableWith ?? []);
  for (const c of PORTAL_CURRENCIES) out.add(c);
  return [...out];
}

/** Apply a SearchParams filter to normalized results (route, date window,
 *  cabin, seats, currencies, and — by default — only space the couple can
 *  actually book).
 *
 *  Callers rely on this returning the SAME OBJECT REFERENCES it was given, so
 *  a Set-membership test after filtering identifies survivors (PointsYeah uses
 *  that to pair kept results back to their detail URLs). Do not map or clone. */
export function filterForParams(
  results: AvailabilityResult[],
  p: SearchParams,
  opts: { bookableOnly?: boolean } = {},
): AvailabilityResult[] {
  const bookableOnly = opts.bookableOnly ?? true;
  return results.filter((r) => {
    if (r.origin !== p.origin || r.destination !== p.destination) return false;
    if (r.flightDate < p.dateStart || r.flightDate > p.dateEnd) return false;
    if (p.cabins?.length && !p.cabins.includes(r.cabin)) return false;
    if (r.seatsAvailable < p.minSeats) return false;
    const bookable = bookableCurrencies(r);
    if (bookableOnly && bookable.length === 0) return false;
    // Currency filter: keep only space bookable with a selected currency — by
    // transfer or, when we know the fare, through that currency's portal.
    if (p.currencies?.length && !bookable.some((c) => p.currencies!.includes(c))) return false;
    return true;
  });
}
