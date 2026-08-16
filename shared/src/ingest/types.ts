import type { AvailabilityResult } from "../types.js";

// What a completed unit of gathering work looks like on its way into the
// database. One producer — the Worker's own seats.aero search — hands these to
// `applyTask` in-process.
//
// This was once a WIRE contract, because a second source ran on a laptop and
// POSTed its results to `/api/ingest/*`. That source is gone and so is the
// endpoint; what survives is the shape, because the properties it encodes are
// about honesty rather than transport: a task that was refused must be
// distinguishable from one that looked and found nothing, whoever ran it.
//
// The display half of this IS part of the wire contract: `SourceTaskStatus` and
// `RunStatus` are re-exported through `shared/src/wire/domain.ts`, which the SPA
// imports. **It reaches this file by its DEEP path**, never through
// `../ingest/index.js` — that re-exports `apply.ts`, which names `D1Database` at
// module scope and would break `tsc -p app`.

/** How a single unit of gathering work ended.
 *
 *  The distinction that matters: `empty` means "I looked and there is no award
 *  space"; everything below it means "I did not get a usable answer". Those
 *  produce identical availability data and must never produce identical
 *  metadata, because only the first one is allowed to claim coverage. */
export type SourceTaskStatus =
  /** Looked, found something. */
  | "ok"
  /** Looked, genuinely nothing there. Claims coverage — this is the point. */
  | "empty"
  /** Threw. Claims nothing. */
  | "failed"
  /** Never attempted (horizon, filter, aborted run). Claims nothing. */
  | "skipped"
  /** Refused at the door — 403/428/444/challenge page. Claims nothing. */
  | "blocked"
  /** A challenge appeared and needs a human. Claims nothing. */
  | "challenged"
  /** Ran out of time. Claims nothing. */
  | "timeout";

/** Statuses that are allowed to write `search_coverage` rows.
 *
 *  INVARIANT: keep this list exactly {ok, empty}. Coverage is a claim that this
 *  source searched this slice and its findings are the complete truth for it —
 *  which is what licenses deleting the slice's other stored rows. Adding any
 *  "didn't really get an answer" status here hard-deletes real finds. */
export const COVERAGE_CLAIMING_STATUSES: readonly SourceTaskStatus[] = ["ok", "empty"];

export function claimsCoverage(status: SourceTaskStatus): boolean {
  return COVERAGE_CLAIMING_STATUSES.includes(status);
}

/** One completed unit of work, with whatever it found. */
export interface SourceTaskReport {
  source: string;
  /** Stable within a run — the idempotency key for re-POSTing a batch. */
  taskKey: string;
  /** The task's representative city pair. `search_runs` and `search_tasks`
   *  store these as NOT NULL scalars, so they are always a REAL airport each —
   *  never a comma-joined list, whatever the task actually asked about. */
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
   * impossible: `search_coverage`'s primary key would happily store an
   * "airport" called `SEA,PDX` and nothing would ever match it again.
   */
  routes?: { origin: string; destination: string }[];
  /** Dates this task asked about. */
  dates: string[];
  /** Programs this task's coverage claim spans. One entry for a direct source. */
  programs: string[];
  status: SourceTaskStatus;
  startedAt: number;
  finishedAt: number;
  attempts?: number;
  error?: string;
  finalUrl?: string;
  httpStatus?: number;
  /** Whatever the source wants kept for forensics on a bad task. */
  capture?: unknown;
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

export type RunStatus = "running" | "ok" | "partial" | "failed" | "aborted";

/** ok + at least one failure = partial. It matters that a run with any failed
 *  task never reads as a clean sweep: a silent partial looks exactly like "there
 *  is no award space". Shared by the search endpoint and the alert sweep. */
export function runStatus(
  ok: number,
  failed: number,
  planned: number,
): Exclude<RunStatus, "running"> {
  if (planned === 0) return "ok";
  if (failed === 0) return "ok";
  if (ok === 0) return "failed";
  return "partial";
}

/** What applying one task actually did to the database. Accumulated onto the
 *  run so a caller can report it. */
export interface ApplyTaskResult {
  offersKept: number;
  snapshotsWritten: number;
  snapshotsPruned: number;
  coverageRows: number;
  changeCounts: { new: number; more_seats: number; price_drop: number; gone: number };
}
