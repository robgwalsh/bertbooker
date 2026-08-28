import { req } from "./client";
import type { PriceHistory } from "../../../shared/src/wire/index.js";

/**
 * What one slot has cost over time.
 *
 * Free — a pure read of the Worker's `price_history` — which is why, unlike
 * `enrichFind` beside it, nothing here quotes a call cost or asks first.
 *
 * Keyed on the slot rather than on a find, because the series outlives the find:
 * once an award is gone there is no current row to hang it off, and that is
 * exactly when the history is worth reading.
 */
export const findHistory = (q: {
  origin: string;
  destination: string;
  flightDate: string;
  program: string;
  cabin: string;
}) => req<PriceHistory>(`/finds/history?${new URLSearchParams(q)}`);
