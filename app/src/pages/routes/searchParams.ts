// The Routes page's URL contract.
//
// **It lives with the page, not with the router**, and that is a deliberate
// reversal. It used to sit in `router.tsx`, which meant the shell imported
// `MAX_NIGHTS`/`MAX_NIGHTS_SPAN` out of the page's round-trip logic while the
// page imported `RoutesSearchParams` back out of the shell — a cycle in which
// the shell knew about a page's reading preferences. Now the page owns its own
// params and the router only wires them up.

import { MAX_NIGHTS, MAX_NIGHTS_SPAN } from "../../lib/roundtrip";

/** Which tracked route the Routes page has open, and how it is reading it. All
 *  four live in the URL rather than in component state so a reload, a bookmark
 *  and the back button all land on the view you were reading. Search params are
 *  untrusted input: anything that isn't valid becomes `undefined`, and the page
 *  falls back to a default rather than rendering an empty pane. */
export interface RoutesSearchParams {
  route?: number;
  /**
   * Trip length for a round-trip route's pairing. A reading preference, not a
   * route setting — whether the route pairs at all is `round_trip` on the row
   * itself, edited like every other property.
   *
   * ABSENT IS THE DEFAULT AND MEANS "the whole-window trip": out on the route's
   * `date_start`, back on its `date_end`, and no other pair of dates. That is a
   * different question from any nights range rather than the widest one, which is
   * why absence still spells it — there is deliberately no third param naming the
   * mode, since "no range chosen" and "the whole-window trip" are one state and
   * two ways to spell it would eventually disagree. Present only when somebody
   * picked a range, and only ever as a pair.
   */
  minNights?: number;
  maxNights?: number;
}

export function validateRoutesSearch(search: Record<string, unknown>): RoutesSearchParams {
  const n = Number(search.route);
  const nights = (v: unknown): number | undefined => {
    const x = Number(v);
    return Number.isInteger(x) && x >= 0 && x <= MAX_NIGHTS ? x : undefined;
  };
  let minNights = nights(search.minNights);
  let maxNights = nights(search.maxNights);
  // An inverted or absurdly wide pair is not an error to render, it is a pair
  // to drop: the page falls back to the whole window, exactly the way an
  // unknown `route` falls back to the first one. Dropped together, since half
  // a range is not a range — and a lone `minNights` would otherwise read as a
  // chosen range with a made-up other end.
  if (
    minNights != null &&
    maxNights != null &&
    (minNights > maxNights || maxNights - minNights > MAX_NIGHTS_SPAN)
  ) {
    minNights = undefined;
    maxNights = undefined;
  }
  return {
    route: Number.isInteger(n) && n > 0 ? n : undefined,
    minNights,
    maxNights,
  };
}
