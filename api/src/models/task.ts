import type { AvailabilityResult } from "./availability.js";

// A COMPLETED UNIT OF GATHERING WORK, on its way into the database. One
// producer — the Worker's own seats.aero search — hands these to `applyTask`
// in-process. The properties it encodes are about honesty rather than transport:
// a task that was refused must be distinguishable from one that looked and found
// nothing.
//
// The two rules that read this shape — `claimsCoverage`, which says which
// statuses may delete stored rows, and `runStatus`, which says when a run of
// them counts as clean — live in `features/search/apply.ts` and
// `features/search/run.ts`, their only callers. `COVERAGE_CLAIMING_STATUSES`
// stays here: it is the invariant the shape itself carries, not a decision
// made about it.
//
// The display half IS part of the wire contract: `SourceTaskStatus` and
// `RunStatus` are DECLARED in `api/src/models/wire/domain.ts`, which the SPA imports,
// and re-exported below so every consumer here is unchanged. The invariant that
// pairs with the first of them — `COVERAGE_CLAIMING_STATUSES` — is a runtime
// value and stays on this side.

import type { SourceTaskStatus } from "./wire/domain.js";

export type { RunStatus, SourceTaskStatus } from "./wire/domain.js";

/** Statuses that are allowed to claim coverage.
 *
 *  INVARIANT: keep this list exactly {ok, empty}. Coverage is a claim that this
 *  source searched this slice and its findings are the complete truth for it —
 *  which is what licenses deleting the slice's other stored rows. Adding any
 *  "didn't really get an answer" status here hard-deletes real finds. */
export const COVERAGE_CLAIMING_STATUSES: readonly SourceTaskStatus[] = ["ok", "empty"];

export interface SourceTaskReport {
  source: string;
  /** The task's representative city pair. `runs` stores these as NOT NULL
   *  scalars, so they are always a REAL airport each — never a comma-joined
   *  list, whatever the task actually asked about. */
  origin: string;
  destination: string;
  /**
   * Every city pair this task ASKED about, when that is more than one.
   *
   * One seats.aero call can cover a whole cross product, because the API takes
   * comma-delimited airports. Such a task is entitled to claim `empty` for the
   * pairs that came back with nothing — the query did cover them — and it must,
   * or a find that genuinely vanished on PDX->HND could never be pruned.
   *
   * Omitted means `[{origin, destination}]`, which is every search before
   * multi-airport routes existed. The alternative — deriving the
   * pairs by splitting `origin` on commas — is the bug this field exists to make
   * impossible: an "airport" called `SEA,PDX` would reach the snapshot writes as
   * a real airport code and match nothing that ever asked about SEA or PDX.
   */
  routes?: { origin: string; destination: string }[];
  /** Dates this task asked about. */
  dates: string[];
  /** Programs this task's coverage claim spans. One entry for a direct source. */
  programs: string[];
  status: SourceTaskStatus;
  startedAt: number;
  finishedAt: number;
  error?: string;
  /** Narrower than `dates` when the source answered for only part of the window.
   *  Defaults to `dates`. Over-claiming here deletes real finds. */
  coveredDates?: string[];
  offers: AvailabilityResult[];
}

/**
 * One observation of a metered source's remaining daily API allowance, read off
 * a response header by whoever made the call. Mirrors a row in `source_quota`
 * (migrations/0001_init.sql).
 *
 * For the interactive paths this is a display, not a guard: search and enrich
 * spend first and report after. The one reader that consults it before spending
 * is `alerts/budget.ts`, the scheduled sweep — the only work here that runs with
 * nobody watching. See docs/ALERTS.md §7.
 */
export interface SourceQuotaObservation {
  /** Source id, e.g. "seatsaero". */
  source: string;
  remaining: number;
  /** The daily ceiling, when the vendor states it. Undefined = don't guess. */
  limit?: number;
  /** Unix ms, from the caller's clock. The day bucket is derived from this in
   *  UTC, because that is when seats.aero's allowance resets. */
  observedAt: number;
}

/** What applying one task actually did to the database. Accumulated onto the
 *  run so a caller can report it. */
export interface ApplyTaskResult {
  offersKept: number;
  snapshotsWritten: number;
  snapshotsPruned: number;
  changeCounts: { new: number; more_seats: number; price_drop: number; gone: number };
}
