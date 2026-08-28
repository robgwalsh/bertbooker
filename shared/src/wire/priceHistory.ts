import type { PricePoint } from "./rows.js";

/**
 * GET /api/finds/history — what one slot has cost over time.
 *
 * Scoped to a (route, date, program, cabin) rather than to a find, because that
 * is what `price_history` is keyed on and what survives the find itself: the
 * series outlives the award, which is the whole reason the table exists.
 *
 * Points are oldest first. They are written ON CHANGE, not per search, so this
 * is a step function and consecutive points can be days apart — a reader must
 * hold each value forward rather than interpolating between them.
 */
export interface PriceHistory {
  origin: string;
  destination: string;
  flightDate: string;
  program: string;
  cabin: string;
  points: PricePoint[];
}
