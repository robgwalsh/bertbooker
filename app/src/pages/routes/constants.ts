// The Routes page's tuned constants.
//
// The route-planning numbers it needs — `MAX_ORIGINS`, `MAX_DESTINATIONS` and
// the three `SEATSAERO_*` — are NOT here. They were, as literals, under a
// docblock explaining that they were "hand-mirrored from `api/src/domain/routing.ts`
// and `providers/seatsaero.ts`… copied rather than imported because the SPA
// imports nothing from `shared/`". That reason is gone, so the copies are too:
// they come through `../../api` like every other part of the wire contract, and
// the form can no longer offer a route the Worker would refuse with a 400
// `bad_route_spec` because two files disagreed about a 3.
//
// What remains here is genuinely the page's own: widths, and the two option
// lists its filters offer.

/** The four cabins, in ascending order — the route form's cabin filter. */
export const CABIN_OPTIONS = ["economy", "premium", "business", "first"];

// The couple's transfer currencies, in display order — the options for a route's
// currency filter. (Excludes "direct": a stored find is only ever tagged
// bookable with one of these four transfer partners.)
export const FILTER_CURRENCIES = ["chase_ur", "capital_one", "bilt", "citi_ty"];

/** The widest the route rail is allowed to get. It sizes to its content below
 *  this — see the grid that lays out the two panes. */
export const RAIL_MAX_WIDTH = 320;

/** The header diagram's reserved width — a constant, not a measurement, so the
 *  spec and the action buttons beside it don't move when you select a route
 *  with a different number of airports. Holds `SEA/PDX ⇄ NRT/HND` on one line. */
export const ROUTE_DIAGRAM_WIDTH = 248;
