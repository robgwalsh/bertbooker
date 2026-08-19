// The date window a NEW route gets, and the one date helper two pages share.
//
// It moved here out of `pages/routes/dates.ts` when the Tools page gained a
// "Track these legs" button: a leg discovered through the route graph becomes a
// tracked route, and it must get the same window a hand-made one does or the two
// surfaces would quietly disagree about what "a new route" means. `usDate` stays
// page-private, because formatting a stored window is still the Routes page's
// business alone.
//
// In `lib/` rather than `components/` because it is pure and wants a test —
// `vitest.config.ts` globs `*.test.ts` only, so this could not live beside a
// component and still be covered.

/**
 * A `Date` as a bare `YYYY-MM-DD`, through UTC.
 *
 * UTC deliberately: a route's window is a pair of bare date strings with no
 * timezone, and handing one to a local-time `Date` shifts it by the viewer's
 * offset — which lands the window a day out west of Greenwich. Same trap
 * `dayLabel` guards against in `lib/format.ts`.
 */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Today through a year out — what an unconfigured route watches.
 *
 * A year is not arbitrary: `SEATSAERO_HORIZON_DAYS` is 365, so it is the whole
 * window seats.aero has anything to say about. Takes `now` rather than reading
 * the clock so it can be tested.
 */
export function defaultRouteWindow(now: Date = new Date()): {
  dateStart: string;
  dateEnd: string;
} {
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);
  return { dateStart: isoDate(now), dateEnd: isoDate(end) };
}
