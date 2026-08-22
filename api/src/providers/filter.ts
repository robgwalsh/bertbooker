import type { AvailabilityResult, Currency } from "../domain/types.js";
import { PORTAL_CURRENCIES } from "../domain/programs.js";

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
 *
 * **This is the reference statement of the rule, and it is mirrored in SQL** —
 * `BOOKABLE_WITH_CLAUSE` in `api/src/db/finds.ts`, plus the same clause
 * hand-written into the Routes page's join. Every filtering caller lives on the
 * read side and speaks SQL, so nothing here calls this at runtime any more; it
 * is kept because the two halves must agree and this one is the testable one.
 * Change this and change the SQL in the same commit.
 */
export function bookableCurrencies(r: AvailabilityResult): Currency[] {
  if (r.cashPriceCents == null) return r.bookableWith ?? [];
  const out = new Set<Currency>(r.bookableWith ?? []);
  for (const c of PORTAL_CURRENCIES) out.add(c);
  return [...out];
}
