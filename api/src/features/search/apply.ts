import { changeKey, diffAvailability, summarizeChange, type ChangeSummary } from "../../models/change.js";
import { collapseBy } from "../../models/offer.js";
import type { AvailabilityResult } from "../../models/availability.js";
import { claimsCoverage, type ApplyTaskResult, type SourceTaskReport } from "../../models/task.js";
import { deleteFinds, selectBaselineFinds, upsertFinds } from "../../db/finds.js";

// The write side of the pivot: one completed unit of gathering becomes rows in
// `finds`, plus a diff for the run summary and the alert digest.

/** Small, stable, synchronous hash (FNV-1a) over the fields that define a
 *  distinct availability state — used to skip writing unchanged rows. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Hash the SOURCE's claim about a slot.
 *
 * `segments` is in here, so a real itinerary hashes differently from the
 * synthetic one a summary row carries. That is correct for *ingest* — an
 * itinerary changing under a steady price is a real change — but it means the
 * hash of an ENRICHED row no longer describes what its source said. Which is why
 * the baseline is read from the stored `raw_hash` rather than recomputed from
 * the row; see `loadPrevious`.
 */
export function hashResult(r: AvailabilityResult): string {
  return fnv1a(
    [
      r.program,
      r.cabin,
      r.flightDate,
      r.seatsAvailable,
      r.milesCost,
      r.cashFeesCents,
      r.isDirect ? 1 : 0,
    ].join("|") + JSON.stringify(r.segments),
  );
}

/** One (date, program) the task claims to have searched. */
export interface CoverageSlice {
  flightDate: string;
  program: string;
}

/** Collapse to one offer per (route, date, program, cabin) — the row key. Two
 *  itineraries for one slot would flap in the diff; see `collapseBy`.
 *
 *  The route belongs in the key because one task can return more than one: a
 *  co-terminal search (SFO→NRT on Delta) answers with SFO→HND itineraries
 *  alongside the SFO→NRT ones, and those are distinct rows. */
export function collapseOffers(offers: AvailabilityResult[]): AvailabilityResult[] {
  return collapseBy(
    offers,
    (o) => `${o.origin}-${o.destination}|${o.flightDate}|${o.program}|${o.cabin}`,
  );
}

/**
 * What this task is allowed to claim it searched.
 *
 * Two rules, and the second keeps the superset invariant true by construction
 * rather than by an adapter author remembering it:
 *
 *  1. Only `ok` and `empty` claim anything. A task that threw, was blocked, hit a
 *     challenge, or was skipped never looked — so its absence of results means
 *     nothing and must not delete stored finds.
 *  2. A returned offer proves the slice it came from WAS searched, so every
 *     (date, program) present in `offers` is folded in even if the declared
 *     window somehow missed it. Coverage can therefore never be narrower than
 *     what was returned, which is the direction that would strand rows as
 *     permanently unprunable.
 *
 * Pure.
 */
export function coverageSlices(task: SourceTaskReport): CoverageSlice[] {
  if (!claimsCoverage(task.status)) return [];
  const out = new Map<string, CoverageSlice>();
  const add = (flightDate: string, program: string) =>
    out.set(`${flightDate}|${program}`, { flightDate, program });

  for (const flightDate of task.coveredDates ?? task.dates) {
    for (const program of task.programs) add(flightDate, program);
  }
  for (const o of task.offers) add(o.flightDate, o.program);
  return [...out.values()];
}

/**
 * Which stored rows this task's success licenses deleting.
 *
 * A coverage slice means "this task searched (date, program) and what it
 * returned is the complete truth for it" — so anything previously recorded
 * inside that slice and not reported again is genuinely gone.
 *
 * Note what this does NOT test: the route pair. `previous` is already filtered
 * to the pairs the task touched, by `loadPrevious`, and that filter is the only
 * thing standing between a task and pruning a pair it never looked at. Pure.
 */
export function prunable(
  previous: AvailabilityResult[],
  kept: AvailabilityResult[],
  slices: CoverageSlice[],
): AvailabilityResult[] {
  const covered = new Set(slices.map((s) => `${s.flightDate}|${s.program}`));
  const keptKeys = new Set(kept.map(changeKey));
  return previous.filter(
    (p) => covered.has(`${p.flightDate}|${p.program}`) && !keptKeys.has(changeKey(p)),
  );
}

/** Parse a JSON-array column, tolerating NULL and anything malformed. These
 *  columns are informational; a bad value must not break a baseline read. */
function jsonArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

export function rowToResult(r: Record<string, unknown>): AvailabilityResult {
  return {
    origin: String(r.origin),
    destination: String(r.destination),
    flightDate: String(r.flight_date),
    program: String(r.program),
    cabin: r.cabin as AvailabilityResult["cabin"],
    seatsAvailable: Number(r.seats_available),
    milesCost: Number(r.miles_cost),
    cashFeesCents: Number(r.cash_fees_cents),
    feesCurrency: String(r.fees_currency),
    isDirect: Number(r.is_direct) === 1,
    segments: JSON.parse(String(r.segments_json)),
    // NULL is a real answer here — "a connecting award exists, nobody said how
    // many stops" — and must stay `undefined` rather than becoming a guess.
    stops: r.stop_count == null ? undefined : Number(r.stop_count),
    airlines: jsonArray(r.airlines),
    directAirlines: jsonArray(r.direct_airlines),
    directMilesCost: r.direct_miles_cost == null ? undefined : Number(r.direct_miles_cost),
    durationMinutes: r.duration_minutes == null ? undefined : Number(r.duration_minutes),
    bookingUrl: r.booking_url == null ? undefined : String(r.booking_url),
    sourceRecordId: r.source_record_id == null ? undefined : String(r.source_record_id),
    detailLevel: r.detail_level === "summary" ? "summary" : "itinerary",
    sourceFetchedAt: Number(r.source_fetched_at),
    bookableWith: JSON.parse(String(r.transfer_currencies ?? "[]")),
  };
}

/** A baseline row plus the hash the SOURCE's claim had when it was written.
 *
 *  The two are carried separately because they can legitimately disagree: an
 *  enriched row's `segments` no longer match the summary that produced its
 *  `raw_hash`. The stored hash decides "has anything changed upstream"; the row
 *  is what the diff and the pruner reason about. */
export interface PreviousFind {
  result: AvailabilityResult;
  rawHash: string;
}

/**
 * Every (origin, destination) this task is about.
 *
 * Three ways a pair gets in here, and they compose:
 *
 *  1. the pair the task asked for;
 *  2. every OTHER pair it asked for in the same breath — a seats.aero call takes
 *     comma-delimited airports, so one query legitimately covers a whole cross
 *     product (`task.routes`);
 *  3. any pair the carrier substituted. A co-terminal answer (SFO→NRT returning
 *     mostly SFO→HND) means one task touches a route it never asked about.
 *
 * `task.routes` is read INSTEAD of splitting `task.origin`, and that is the whole
 * safety property: this list becomes the baseline read's pair filter, and a
 * comma-joined value would enter it as an airport named `SEA,PDX` that matches no
 * stored row — leaving the real pairs' rows outside the baseline, so invisible to
 * write-on-change and untouchable by the pruner.
 */
export function routesTouched(
  task: Pick<SourceTaskReport, "origin" | "destination" | "routes">,
  kept: AvailabilityResult[],
): { origin: string; destination: string }[] {
  const seen = new Map<string, { origin: string; destination: string }>();
  const asked = task.routes?.length
    ? task.routes
    : [{ origin: task.origin, destination: task.destination }];
  for (const r of asked) seen.set(`${r.origin}-${r.destination}`, r);
  for (const o of kept) seen.set(`${o.origin}-${o.destination}`, { origin: o.origin, destination: o.destination });
  return [...seen.values()];
}

/**
 * The baseline for this task: the stored rows over the span it touched, each
 * with the hash the SOURCE's claim had when it was written.
 *
 * The stored `raw_hash` is returned rather than recomputed, and that is the
 * point. Recomputing asks "what would this row hash to now", which stops being
 * the right question the moment anything augments a row after it was written: an
 * enrichment replaces `segments_json` with the real legs, and `hashResult` folds
 * segments in, so a recomputed baseline would differ from the unchanged summary
 * arriving next and rewrite the row — discarding the enrichment on every search,
 * forever.
 *
 * The empty-input guard is HERE and only here. `selectBaselineFinds` builds a
 * statement whose pair test is an `IN` list, and an empty one is a syntax error;
 * this is the one place that decision is made.
 */
async function loadPrevious(
  db: D1Database,
  slices: CoverageSlice[],
  routes: { origin: string; destination: string }[],
): Promise<PreviousFind[]> {
  if (slices.length === 0 || routes.length === 0) return [];
  const dates = slices.map((s) => s.flightDate).sort();
  const lo = dates[0]!;
  const hi = dates[dates.length - 1]!;

  const results = await selectBaselineFinds(db, routes, lo, hi);
  return results.map((r) => ({ result: rowToResult(r), rawHash: String(r.raw_hash ?? "") }));
}

/**
 * Apply one completed task.
 *
 * Order matters: read the baseline, write what changed, then prune what the
 * coverage claim licenses.
 *
 * The claim is `slices`, computed here and never stored. It is decided BEFORE
 * anything is written and describes only what this task looked at, so a crash
 * mid-apply performs fewer deletes than it was entitled to and never more —
 * under-claiming costs a stale row, over-claiming destroys one.
 */
export async function applyTask(
  db: D1Database,
  task: SourceTaskReport,
): Promise<ApplyTaskResult & { changes: ChangeSummary[] }> {
  const empty: ApplyTaskResult & { changes: ChangeSummary[] } = {
    offersKept: 0,
    snapshotsWritten: 0,
    snapshotsPruned: 0,
    changeCounts: { new: 0, more_seats: 0, price_drop: 0, gone: 0 },
    changes: [],
  };

  const slices = coverageSlices(task);
  // A task that claims nothing has nothing to say about the world. Its offers
  // (if any) are dropped rather than written: a blocked or timed-out task that
  // read half a page is exactly the kind of partial truth that should not become
  // the stored answer.
  if (slices.length === 0) return empty;

  const kept = collapseOffers(task.offers);
  const routes = routesTouched(task, kept);
  const stored = await loadPrevious(db, slices, routes);
  const previous = stored.map((p) => p.result);

  // --- write only what changed -----------------------------------------------
  // Keyed off the hash STORED with each row, not one recomputed from it. See
  // `loadPrevious`: a row that has been enriched since it was written would
  // recompute to something else and be rewritten every single search.
  const prevHash = new Map(stored.map((p) => [changeKey(p.result), p.rawHash] as const));
  const changed = kept
    .map((result) => ({ result, rawHash: hashResult(result) }))
    .filter(({ result, rawHash }) => prevHash.get(changeKey(result)) !== rawHash);
  const snapshotsWritten = await upsertFinds(db, changed);

  // --- prune what this task's own coverage licenses deleting ------------------
  const snapshotsPruned = await deleteFinds(db, prunable(previous, kept, slices));

  // --- diff, for the run summary and the digest ------------------------------
  const tally = { new: 0, more_seats: 0, price_drop: 0, gone: 0 };
  const changes: ChangeSummary[] = [];
  for (const change of diffAvailability(previous, kept)) {
    tally[change.type] += 1;
    changes.push(summarizeChange(change));
  }

  return {
    offersKept: kept.length,
    snapshotsWritten,
    snapshotsPruned,
    changeCounts: tally,
    changes,
  };
}
