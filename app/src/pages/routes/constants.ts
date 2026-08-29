// The Routes page's tuned constants.
//
// The route-planning numbers it needs — `MAX_ORIGINS`, `MAX_DESTINATIONS` and
// the three `SEATSAERO_*` — are NOT here: they come through `../../api` like
// every other part of the wire contract, so the form can never offer a route
// the Worker would refuse with a 400 `bad_route_spec` because two files
// disagreed about a 3.
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
