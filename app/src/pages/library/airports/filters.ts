// The Airports pane's filter vocabulary. Plain data — the labels and colours
// each type draws with live in `lib/airportTypes.ts`, shared with the map's
// legend.

/** Types in descending usefulness, which is also the order the filter menu and
 *  the legend list them in. */
export const TYPE_ORDER = [
  "large_airport",
  "medium_airport",
  "small_airport",
  "heliport",
  "seaplane_base",
  "balloonport",
];

export const CONTINENTS = [
  { code: "AF", label: "Africa" },
  { code: "AS", label: "Asia" },
  { code: "EU", label: "Europe" },
  { code: "NA", label: "North America" },
  { code: "SA", label: "South America" },
  { code: "OC", label: "Oceania" },
  { code: "AN", label: "Antarctica" },
];

/** Rows the TABLE lists. The map plots the whole matching set at a much higher
 *  cap (`/api/airports/geo`) — the two share one WHERE builder server-side, so
 *  this is a display limit and not a different question. */
export const RESULT_LIMIT = 100;
