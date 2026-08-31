import type { AvailabilityResult } from "./availability.js";
import type { ChangeType } from "./wire/domain.js";

// WHAT MOVED between two observations of the same slot — the shape only. The
// rule that decides it, `diffAvailability`, lives in `features/search/apply.ts`
// now: a `price_drop` is whatever that function calls one, and the Routes
// page, the run summary and the alert digest all have to mean the same thing
// by it, but deciding that is logic, not vocabulary.
//
// `ChangeType` and `ChangeSummary` are declared in `api/src/models/wire/domain.ts` —
// the SPA renders both, so the wire contract owns them and this module
// re-exports them.
export type { ChangeSummary, ChangeType } from "./wire/domain.js";

export interface AvailabilityChange {
  type: ChangeType;
  /** The current result (absent for "gone"). */
  current?: AvailabilityResult;
  /** The prior result (absent for "new"). */
  previous?: AvailabilityResult;
  /** Stable identity of the route+program+cabin+date this change concerns. */
  key: string;
}
