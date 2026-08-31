/**
 * Pure constants and vocabularies for the seats.aero pane. No JSX, so the values
 * a test would want to reach are reachable.
 */

/** Rows the table asks for. The caption says so when the cap is what limited the
 *  list, the same way the Airports table does. */
export const ROUTE_TABLE_LIMIT = 200;

/** Rows the map asks for. Far higher than the table's — the table lists the top
 *  matches while the map draws the whole matching set. */
export const ROUTE_GEO_LIMIT = 20_000;

/**
 * Arcs actually drawn.
 *
 * A measured graph is ~8,300 pairs and every one of them is a vector on the
 * canvas. This is the point where more ink stops being more information: past a
 * few thousand overlapping great circles the picture is a solid smear. What the
 * cap drops is counted and captioned rather than quietly missing.
 */
export const MAX_DRAWN_LINES = 2_500;

/** The six values seats.aero uses, measured across two full graphs on
 *  2026-08-18. Hard-coded because it is a closed set of six words and a
 *  SELECT DISTINCT per keystroke to discover them would be absurd. */
export const REGIONS = [
  "Africa",
  "Asia",
  "Europe",
  "North America",
  "Oceania",
  "South America",
] as const;

/** Distance bands, in statute miles. The upper bound is open — the longest
 *  measured pair was 10,933 mi. */
export const DISTANCE_BANDS: { label: string; min?: number; max?: number }[] = [
  { label: "Any" },
  { label: "Under 1,000", max: 999 },
  { label: "1,000 – 3,000", min: 1000, max: 3000 },
  { label: "3,000 – 6,000", min: 3000, max: 6000 },
  { label: "Over 6,000", min: 6000 },
];
