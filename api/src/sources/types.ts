import type { AvailabilityResult } from "../domain/types.js";
import type { SourceQuotaObservation, SourceTaskStatus } from "../ingest/types.js";

/**
 * The source plug-in contract.
 *
 * A **source** is anything that can answer "what award space exists on this
 * route, on these dates". The app knows nothing else about where its data comes
 * from: a source produces `AvailabilityResult[]`, the ingest pipeline
 * (`ingest/apply.ts`) decides what that means for the database, and every read
 * goes through one CTE regardless of who wrote the row.
 *
 * docs/SOURCES.md is the guide. What follows is the contract itself.
 */

/**
 * What to gather.
 *
 * Deliberately not a filter object. Cabin, seat-count and currency filters
 * belong at read time, because anything filtered out here is silently missing
 * from the database for every future question — including ones nobody has asked
 * yet. **Gather wide, query narrow.**
 *
 * `programs` is the one exception, and it is not a result filter: it selects
 * which SOURCES bother to run at all.
 */
export interface SourceQuery {
  origin: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  programs?: string[];
}

/**
 * One unit of work: whatever a source can do in a single observable attempt —
 * one API call, one date range. Small enough that its failure is informative,
 * large enough that the metadata isn't noise.
 *
 * Each task becomes a row in `search_tasks` with its own status, timing and
 * error. That is the property the whole design rests on: "11 of 14 came back and
 * three were refused" has to be queryable, not a log line.
 */
export interface SourceTask {
  /** Stable within a run. It is the idempotency key when a batch POST is
   *  retried — `(run_id, source, task_key)` is UNIQUE — so it MUST be derived
   *  from the work, never from a counter or a clock. */
  key: string;
  source: string;
  origin: string;
  destination: string;
  /** Dates this task asks about — its coverage claim if it succeeds. */
  dates: string[];
  /** Programs its coverage claim spans. One entry for a single-program source. */
  programs: string[];
  /** Source-private. The source built this task, so only it needs the shape. */
  payload?: unknown;
}

export interface SourceResult {
  offers: AvailabilityResult[];
  /**
   * Narrower than `task.dates` when the source answered for only part of the
   * window. **Read this off the payload, never off the plan.** Services clamp
   * windows near today and near their horizon; over-claiming hard-deletes real
   * finds, under-claiming costs a stale row. When unsure, narrow it.
   */
  coveredDates?: string[];
  /** Forensics, stored on the task row so a bad run is diagnosable later. */
  finalUrl?: string;
  httpStatus?: number;
  capture?: unknown;
  notes?: string[];
  /** A metered source's remaining daily allowance, as the response reported it.
   *  A fact about the SOURCE, not this task — the newest observation wins
   *  regardless of which task produced it. */
  quota?: SourceQuotaObservation;
}

export interface SourceCtx {
  /** ISO date the plan was built against. Passed rather than read from the
   *  clock so a run is reproducible and testable. */
  today: string;
  log(msg: string, fields?: Record<string, unknown>): void;
  signal?: AbortSignal;
}

/**
 * Identity. Every source has one of these, and the registry is the catalogue.
 *
 * There used to be a `runtime: "worker" | "local"` field here, because a second
 * source could not run on Cloudflare and had to be driven from a laptop. That
 * source is gone and so is the field — but the rule it encoded still decides
 * what may be added, and docs/SOURCES.md states it: this Worker may call a
 * service that authenticates the CREDENTIAL, and may not call one that judges
 * the CLIENT. A source that fails that test does not get a different runtime
 * now; it does not get added.
 */
export interface SourceDescriptor {
  /** Stable id, and the value stored in `availability_snapshots.source` and
   *  `search_coverage.source`.
   *
   *  It is a PERMANENT STORED VALUE. Renaming one without migrating those two
   *  tables orphans every row it ever wrote: prunes are scoped per source, so
   *  nothing would ever clean them and they would read as current forever. */
  readonly id: string;
  /** Human label for the UI and for run logs. */
  readonly label: string;
  /** programs.code values this source can emit. Every one MUST exist in
   *  `PROGRAM_SEEDS` — `availability_snapshots.program` is a foreign key, so a
   *  typo here is a write that fails at runtime. */
  readonly programs: string[];
  /** How far ahead this source can see. Establish it empirically; a guess that
   *  is too high wastes calls on an empty horizon, one too low silently caps
   *  the app's reach. */
  readonly horizonDays: number;
}

/**
 * A source a **generic** runner could drive: plan the window into tasks, run
 * each one, hand the results to ingest.
 *
 * **Nothing implements this today, and that is the honest state of it.**
 * seats.aero — the only source — is a `SourceDescriptor` only, because the
 * Worker drives it through a specialised runner (`api/src/searchRun.ts`) that
 * streams each HTTP call to the browser as it lands, meters a per-request
 * subrequest budget, and resumes across requests when it runs out. Expressing
 * that through a plain `run()` would mean pushing streaming callbacks and call
 * accounting into this interface — making every future source carry
 * seats.aero's shape. The split is by **who drives the source**.
 *
 * This is kept as the seam a second source would implement, and the docblock on
 * `run` below is the part worth keeping either way: it states the failure
 * protocol the ingest pipeline depends on.
 */
export interface RunnableSource extends SourceDescriptor {
  /** False bows the source out entirely — no request issued. A single-program
   *  source declines a run filtered to other programs. */
  supports(q: SourceQuery): boolean;

  /** PURE. Break the window into tasks, clamped to `horizonDays`. Planning must
   *  not touch the network: it is called to price a run before deciding whether
   *  to spend anything on it. */
  plan(q: SourceQuery, today: string): SourceTask[];

  /**
   * Execute one task.
   *
   * **THROWING IS THE FAILURE PROTOCOL.** The runner catches, classifies the
   * throw into a status, and continues with the next task. Never return an empty
   * result to signal failure: `offers: []` means "I looked and there is no award
   * space", which CLAIMS COVERAGE and licenses deleting the stored rows for that
   * slice. Only `ok` and `empty` claim anything; `failed`, `blocked`,
   * `challenged`, `timeout` and `skipped` claim nothing, which is what stops a
   * refused task from destroying real data.
   */
  run(task: SourceTask, ctx: SourceCtx): Promise<SourceResult>;

  /** Optional per-run setup and teardown — a shared transport, a session. */
  open?(ctx: SourceCtx): Promise<void>;
  close?(): Promise<void>;
}

/** Narrowing helper: is this catalogue entry one the generic runner can drive? */
export function isRunnable(s: SourceDescriptor): s is RunnableSource {
  return typeof (s as RunnableSource).run === "function";
}

export type { SourceTaskStatus };
