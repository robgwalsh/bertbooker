import type { AvailabilityResult } from "./availability.js";

/**
 * The subset of fields `betterOffer`/`collapseBy` (`api/src/providers/collapse.ts`)
 * read to decide which of two offers is better. Both `AirlineOffer`
 * (carrier-shaped, pre-normalization) and `AvailabilityResult` (normalized)
 * satisfy it, which is the point: the rule is a domain decision about award
 * value, not a detail of either shape.
 */
export type Collapsible = Pick<
  AvailabilityResult,
  "flightDate" | "cabin" | "milesCost" | "seatsAvailable" | "segments"
> &
  Partial<Pick<AvailabilityResult, "stops" | "durationMinutes">>;
