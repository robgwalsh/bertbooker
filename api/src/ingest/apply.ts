import { changeKey, diffAvailability, summarizeChange, type ChangeSummary } from "../domain/diff.js";
import { collapseBy } from "../domain/collapse.js";
import { routeKey, type AvailabilityResult } from "../domain/types.js";
import { claimsCoverage, type ApplyTaskResult, type SourceTaskReport } from "./types.js";

// The write side of the pivot. A source reports one completed unit of
// work; this turns it into snapshot rows, coverage rows, and a diff — with the
// per-source scoping that makes it safe for gathering and querying to be
// separated in time.

/** Small, stable, synchronous hash (FNV-1a) over the fields that define a
 *  distinct availability state — used to skip writing unchanged snapshots. */
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
 * Note what this does and does not cover, because enrichment depends on it:
 * `segments` is in here, so a real itinerary hashes differently from the
 * synthetic one a summary row carries. That is correct for *ingest* — an
 * itinerary changing under a steady price is a real change — but it means the
 * hash of an ENRICHED row no longer describes what its source said. Which is
 * why the baseline is read from the stored `raw_hash` rather than recomputed
 * from the row; see `loadPreviousForSource`.
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
      // Must be here, or a fare that moved while the award price held steady
      // would hash identically and never be written.
      r.cashPriceCents ?? "",
      r.isDirect ? 1 : 0,
    ].join("|") + JSON.stringify(r.segments),
  );
}

/** One (date, program) the task claims to have searched. */
export interface CoverageSlice {
  flightDate: string;
  program: string;
}

/** Collapse to one offer per (route, date, program, cabin) — the snapshot key.
 *  Two itineraries for one slot would flap in the diff; see `collapseBy`.
 *
 *  The route belongs in the key because one task can return more than one:
 *  a co-terminal search (SFO→NRT on Delta) answers with SFO→HND itineraries
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
 * Two rules, and the second is what keeps the superset invariant true by
 * construction rather than by an adapter author remembering it:
 *
 *  1. Only `ok` and `empty` claim anything. A task that threw, was blocked, hit
 *     a challenge, or was skipped never looked — so its absence of results means
 *     nothing and must not delete the source's stored finds.
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
 * A coverage slice means "this source searched (date, program) and what it
 * returned is the complete truth for it" — so anything this source previously
 * recorded inside that slice and did not report again is genuinely gone.
 *
 * Scoped to ONE SOURCE. `previous` must already be filtered to the task's
 * source, which is what makes this strictly safer than the pre-pivot blanket
 * prune: a browser source failing can no longer delete an aggregator's finds,
 * because it never had the authority to speak for them. Pure.
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

const SNAPSHOT_COLUMNS = `s.origin, s.destination, s.flight_date, s.program, s.cabin,
       s.seats_available, s.miles_cost, s.cash_fees_cents, s.fees_currency,
       s.is_direct, s.segments_json, s.source, s.source_fetched_at,
       s.transfer_currencies, s.duration_minutes, s.booking_url,
       s.cash_price_cents, s.cash_price_currency, s.raw_hash,
       s.source_record_id, s.detail_level,
       s.stop_count, s.airlines, s.direct_airlines, s.direct_miles_cost`;

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
    cashPriceCents: r.cash_price_cents == null ? undefined : Number(r.cash_price_cents),
    cashPriceCurrency: r.cash_price_currency == null ? undefined : String(r.cash_price_currency),
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
    source: String(r.source),
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
 *  `raw_hash`. The stored hash is the one that decides "has anything changed
 *  upstream"; the row is what the diff and the pruner reason about. */
export interface PreviousSnapshot {
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
 * `task.routes` is read INSTEAD of splitting `task.origin`, and that is the
 * whole safety property: `search_coverage`'s primary key is (origin,
 * destination, …), so a comma-joined value would be stored as an airport named
 * `SEA,PDX` that no future query could ever match — leaving the real pairs
 * looking permanently unchecked while the pruner believed otherwise.
 *
 * Exported for the tests that pin all three.
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

/** Latest snapshot per (route_key, program, cabin) **for one source**, over the
 *  span the task touched. Deliberately a date RANGE rather than an IN-list: a
 *  stride plan can name 300 dates, and over-selecting here is free because the
 *  slice test happens in `prunable`.
 *
 *  The route list matters for write-on-change, not just for pruning: leave a
 *  substituted airport out of the baseline and every one of its rows looks new
 *  on every run, so "a re-run writes zero snapshots" — the cheapest smoke
 *  test this pipeline has — would quietly stop being true.
 *
 *  Returns the STORED `raw_hash` alongside each row rather than leaving the
 *  caller to recompute it. Recomputing asks "what would this row hash to now",
 *  which stops being the right question the moment anything augments a row
 *  after it was written: an enrichment replaces `segments_json` with the real
 *  legs, and `hashResult` folds segments in, so a recomputed baseline would
 *  differ from the unchanged summary arriving next and rewrite the row —
 *  discarding the enrichment on every search, forever. The stored hash still
 *  says what the SOURCE said, which is the only thing write-on-change asks. */
async function loadPreviousForSource(
  db: D1Database,
  task: SourceTaskReport,
  slices: CoverageSlice[],
  routes: { origin: string; destination: string }[],
): Promise<PreviousSnapshot[]> {
  if (slices.length === 0 || routes.length === 0) return [];
  const dates = slices.map((s) => s.flightDate).sort();
  const lo = dates[0]!;
  const hi = dates[dates.length - 1]!;

  const pairs = routes.map((r) => `${r.origin}-${r.destination}`);
  const placeholders = pairs.map(() => "?").join(", ");

  const { results } = await db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS}
         FROM availability_snapshots s
         JOIN (
           SELECT route_key, program, cabin, MAX(captured_at) AS mx
             FROM availability_snapshots
            WHERE (origin || '-' || destination) IN (${placeholders}) AND source = ?
              AND flight_date BETWEEN ? AND ?
            GROUP BY route_key, program, cabin
         ) latest
           ON latest.route_key = s.route_key AND latest.program = s.program
          AND latest.cabin = s.cabin AND latest.mx = s.captured_at
        WHERE (s.origin || '-' || s.destination) IN (${placeholders}) AND s.source = ?`,
    )
    .bind(...pairs, task.source, lo, hi, ...pairs, task.source)
    .all();

  return results.map((r) => ({ result: rowToResult(r), rawHash: String(r.raw_hash ?? "") }));
}

/**
 * Apply one completed task.
 *
 * Order matters: read the baseline, write changed snapshots, prune what the
 * coverage claim licenses, then record the coverage itself. Coverage last means
 * a crash mid-apply leaves a claim NOT made rather than a claim made for work
 * that was only half-applied — under-claiming costs a stale row, over-claiming
 * destroys one.
 */
export async function applyTask(
  db: D1Database,
  runId: string,
  task: SourceTaskReport,
  now: number = Date.now(),
): Promise<ApplyTaskResult & { changes: ChangeSummary[] }> {
  const empty: ApplyTaskResult & { changes: ChangeSummary[] } = {
    offersKept: 0,
    snapshotsWritten: 0,
    snapshotsPruned: 0,
    coverageRows: 0,
    changeCounts: { new: 0, more_seats: 0, price_drop: 0, gone: 0 },
    changes: [],
  };

  const slices = coverageSlices(task);
  // A task that claims nothing has nothing to say about the world. Its offers
  // (if any) are dropped rather than written: a blocked or timed-out task that
  // read half a page is exactly the kind of partial truth that should not
  // become the stored answer.
  if (slices.length === 0) return empty;

  const kept = collapseOffers(task.offers);
  const routes = routesTouched(task, kept);
  const stored = await loadPreviousForSource(db, task, slices, routes);
  const previous = stored.map((p) => p.result);

  // --- snapshots: write only what changed -----------------------------------
  // Keyed off the hash STORED with each row, not one recomputed from it. See
  // `loadPreviousForSource`: a row that has been enriched since it was written
  // would recompute to something else and be rewritten every single search.
  const prevHash = new Map(stored.map((p) => [changeKey(p.result), p.rawHash] as const));
  const inserts: D1PreparedStatement[] = [];
  for (const r of kept) {
    const h = hashResult(r);
    if (prevHash.get(changeKey(r)) === h) continue; // unchanged — skip the write
    inserts.push(
      db
        .prepare(
          `INSERT INTO availability_snapshots
             (route_key, origin, destination, flight_date, program, cabin,
              seats_available, miles_cost, cash_fees_cents, fees_currency,
              is_direct, segments_json, source, source_fetched_at, raw_hash,
              transfer_currencies, duration_minutes, booking_url,
              cash_price_cents, cash_price_currency, search_run_id,
              source_record_id, detail_level,
              stop_count, airlines, direct_airlines, direct_miles_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          routeKey(r.origin, r.destination, r.flightDate),
          r.origin,
          r.destination,
          r.flightDate,
          r.program,
          r.cabin,
          r.seatsAvailable,
          r.milesCost,
          r.cashFeesCents,
          r.feesCurrency,
          r.isDirect ? 1 : 0,
          JSON.stringify(r.segments),
          r.source,
          r.sourceFetchedAt,
          h,
          JSON.stringify(r.bookableWith ?? []),
          r.durationMinutes ?? null,
          r.bookingUrl ?? null,
          r.cashPriceCents ?? null,
          r.cashPriceCurrency ?? null,
          runId,
          r.sourceRecordId ?? null,
          // Absent means the source produced real legs — which is every source
          // except seats.aero's Cached Search asked without `include_trips`.
          r.detailLevel ?? "itinerary",
          // NULL is a real answer and the whole reason this column is nullable.
          r.stops ?? null,
          r.airlines?.length ? JSON.stringify(r.airlines) : null,
          r.directAirlines?.length ? JSON.stringify(r.directAirlines) : null,
          r.directMilesCost ?? null,
        ),
    );
  }
  if (inserts.length) await db.batch(inserts);

  // --- prune what this source's own coverage licenses deleting ---------------
  const gone = prunable(previous, kept, slices);
  let snapshotsPruned = 0;
  if (gone.length) {
    const deletes = gone.map((r) =>
      db
        .prepare(
          `DELETE FROM availability_snapshots
            WHERE origin = ? AND destination = ? AND flight_date = ?
              AND program = ? AND cabin = ? AND source = ?`,
        )
        .bind(r.origin, r.destination, r.flightDate, r.program, r.cabin, r.source),
    );
    for (const res of await db.batch(deletes)) snapshotsPruned += res.meta.changes ?? 0;
  }

  // --- record the coverage claim --------------------------------------------
  // Claimed for every route the task touched, not just the one it asked for.
  // The alternative — claim only the requested route — leaves a substituted
  // airport's rows prunable (they are in `previous`) but never marked checked,
  // so the finds table would show them as "never looked at" while the pruner
  // was already acting as though it had. One rule for both, or neither.
  const foundPerSlice = new Map<string, number>();
  for (const o of kept) {
    const k = `${o.origin}-${o.destination}|${o.flightDate}|${o.program}`;
    foundPerSlice.set(k, (foundPerSlice.get(k) ?? 0) + 1);
  }
  const coverageStmts = routes.flatMap((route) =>
    slices.map((s) =>
      db
        .prepare(
          `INSERT INTO search_coverage
           (origin, destination, flight_date, program, source, run_id, checked_at, offers_found)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin, destination, flight_date, program, source) DO UPDATE SET
           run_id = excluded.run_id,
           checked_at = excluded.checked_at,
           offers_found = excluded.offers_found`,
        )
        .bind(
          route.origin,
          route.destination,
          s.flightDate,
          s.program,
          task.source,
          runId,
          now,
          foundPerSlice.get(`${route.origin}-${route.destination}|${s.flightDate}|${s.program}`) ?? 0,
        ),
    ),
  );
  // D1 caps a batch; coverage can be dates x programs, so chunk it.
  for (let i = 0; i < coverageStmts.length; i += 50) {
    await db.batch(coverageStmts.slice(i, i + 50));
  }

  // --- diff, for the run summary --------------------------------------------
  const tally = { new: 0, more_seats: 0, price_drop: 0, gone: 0 };
  const changes: ChangeSummary[] = [];
  for (const change of diffAvailability(previous, kept)) {
    tally[change.type] += 1;
    changes.push(summarizeChange(change));
  }

  return {
    offersKept: kept.length,
    snapshotsWritten: inserts.length,
    snapshotsPruned,
    coverageRows: coverageStmts.length,
    changeCounts: tally,
    changes,
  };
}
