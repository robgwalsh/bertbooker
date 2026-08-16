import type { AvailabilityResult } from "../types.js";

// The wire contract between a source runner and the Worker. Two runners use it:
// the Worker's own seats.aero search (in-process) and `packages/local-sources`
// over `/api/ingest/*`. `web/src/api.ts` hand-mirrors the display half, as it
// does for every other endpoint.

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

/** Opening a run from the local runner. It mints the id so a run that dies
 *  before its first successful POST can still be retried under the same
 *  identity. */
export interface IngestRunOpen {
  id: string;
  /** `search_runs.trigger`. The Worker writes `search` and `alert`; the local
   *  runner writes `local`. The column has no CHECK constraint, which is how
   *  these three coexist without a schema change per caller. */
  trigger: "local";
  origin: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  /** Requested program filter; omitted = all. */
  programs?: string[];
  /** Source ids this run intends to use. */
  sources: string[];
  startedAt: number;
  tasksPlanned: number;
  host?: string;
  runnerVersion?: string;
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
   * Omitted means `[{origin, destination}]`, which is every local source and
   * every search before multi-airport routes. The alternative — deriving the
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
  artifactPath?: string;
  /** Narrower than `dates` when the source answered for only part of the window.
   *  Defaults to `dates`. Over-claiming here deletes real finds. */
  coveredDates?: string[];
  offers: AvailabilityResult[];
}

export interface IngestLogLine {
  source?: string;
  /** ms since run start. */
  atMs: number;
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

/** Posted repeatedly as a run proceeds, not once at the end: a run that dies
 *  halfway still leaves its successful tasks in D1. */
export interface IngestBatch {
  tasks: SourceTaskReport[];
  logs?: IngestLogLine[];
  /** Metered sources' remaining daily allowance, as observed during this batch.
   *  Rides the batch rather than getting its own endpoint because whoever made
   *  the call is the only process that sees the number, and the batch POST is
   *  already authenticated and already flushed periodically. */
  quota?: SourceQuotaObservation[];
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
 *  is no award space". Shared by the local runner and the Worker's search
 *  endpoint. */
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

export interface IngestFinish {
  status: Exclude<RunStatus, "running">;
  finishedAt: number;
  error?: string;
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
