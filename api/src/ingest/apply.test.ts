import { describe, expect, it } from "vitest";
import type { AvailabilityResult } from "../domain/types.js";
import {
  applyTask,
  collapseOffers,
  coverageSlices,
  hashResult,
  prunable,
  routesTouched,
} from "./apply.js";
import { claimsCoverage, type SourceTaskReport, type SourceTaskStatus } from "./types.js";

const offer = (o: Partial<AvailabilityResult> = {}): AvailabilityResult => ({
  origin: "SEA",
  destination: "LAX",
  flightDate: "2027-03-05",
  program: "alaska",
  cabin: "business",
  seatsAvailable: 2,
  milesCost: 27_500,
  cashFeesCents: 560,
  feesCurrency: "USD",
  isDirect: true,
  segments: [],
  source: "fetch:alaska",
  sourceFetchedAt: 1_700_000_000_000,
  bookableWith: ["bilt"],
  ...o,
});

const task = (t: Partial<SourceTaskReport> = {}): SourceTaskReport => ({
  source: "fetch:alaska",
  taskKey: "alaska:SEA-LAX:2027-03-05",
  origin: "SEA",
  destination: "LAX",
  dates: ["2027-03-05"],
  programs: ["alaska"],
  status: "ok",
  startedAt: 0,
  finishedAt: 1000,
  offers: [],
  ...t,
});

describe("collapseOffers", () => {
  it("keeps one offer per (date, program, cabin), cheapest miles first", () => {
    const kept = collapseOffers([
      offer({ milesCost: 40_000 }),
      offer({ milesCost: 27_500 }),
      offer({ milesCost: 55_000 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.milesCost).toBe(27_500);
  });

  it("does NOT collapse across programs — the snapshot key includes it", () => {
    // Pre-pivot, an adapter knew its own program so (date, cabin) sufficed.
    // Ingest sees many sources at once, so dropping the program dimension here
    // would silently discard one airline's find in favour of another's.
    const kept = collapseOffers([
      offer({ program: "alaska", milesCost: 27_500 }),
      offer({ program: "aeroplan", milesCost: 60_000 }),
    ]);
    expect(kept.map((k) => k.program).sort()).toEqual(["aeroplan", "alaska"]);
  });

  it("breaks a miles tie on more seats, then fewer stops", () => {
    const kept = collapseOffers([
      offer({ seatsAvailable: 2, stops: 0 }),
      offer({ seatsAvailable: 6, stops: 1 }),
    ]);
    expect(kept[0]!.seatsAvailable).toBe(6);

    const tie = collapseOffers([
      offer({ seatsAvailable: 4, stops: 2 }),
      offer({ seatsAvailable: 4, stops: 0 }),
    ]);
    expect(tie[0]!.stops).toBe(0);
  });

  it("does NOT collapse across routes — one task can answer for several", () => {
    // Delta answers a co-terminal search with the whole city: SFO→NRT comes
    // back mostly SFO→HND, and those are different route keys. Leaving the
    // route out of the key would merge them and throw one real find away.
    const kept = collapseOffers([
      offer({ origin: "SFO", destination: "HND", milesCost: 123_400 }),
      offer({ origin: "SFO", destination: "NRT", milesCost: 499_900 }),
    ]);
    expect(kept.map((k) => k.destination).sort()).toEqual(["HND", "NRT"]);
  });
});

describe("routesTouched", () => {
  it("is just the requested route when the carrier answered the question asked", () => {
    expect(routesTouched(task(), [offer()])).toEqual([{ origin: "SEA", destination: "LAX" }]);
  });

  it("includes airports the carrier substituted", () => {
    // This drives both the write-on-change baseline and the coverage claim.
    // Miss a substituted airport and its rows look new on every single run,
    // which quietly breaks "a re-run writes zero snapshots".
    const routes = routesTouched(task({ origin: "SFO", destination: "NRT" }), [
      offer({ origin: "SFO", destination: "HND" }),
      offer({ origin: "SFO", destination: "NRT" }),
    ]);
    expect(routes).toEqual([
      { origin: "SFO", destination: "NRT" },
      { origin: "SFO", destination: "HND" },
    ]);
  });

  it("always keeps the requested route, even when nothing came back for it", () => {
    // An empty answer for the route asked about is exactly the case that
    // licenses a prune, so it must never drop out of the list.
    const routes = routesTouched(task({ origin: "SFO", destination: "NRT" }), []);
    expect(routes).toEqual([{ origin: "SFO", destination: "NRT" }]);
  });
});

describe("coverageSlices", () => {
  it("claims the declared window for a successful task", () => {
    const slices = coverageSlices(task({ dates: ["2027-03-05", "2027-03-06"] }));
    expect(slices).toEqual([
      { flightDate: "2027-03-05", program: "alaska" },
      { flightDate: "2027-03-06", program: "alaska" },
    ]);
  });

  it("claims the empty window too — 'I looked and there is nothing' is an answer", () => {
    // This is the whole reason the status enum distinguishes `empty` from
    // `failed`. Without a coverage claim here, space that genuinely went away
    // would never be pruned and the Routes page would show it forever.
    expect(coverageSlices(task({ status: "empty", offers: [] }))).toHaveLength(1);
  });

  it.each<SourceTaskStatus>(["failed", "skipped", "blocked", "challenged", "timeout"])(
    "claims NOTHING when the task ended %s",
    (status) => {
      // The invariant that protects stored finds: a source that was refused at
      // the door has said nothing about whether the award space still exists.
      expect(claimsCoverage(status)).toBe(false);
      expect(coverageSlices(task({ status, offers: [offer()] }))).toEqual([]);
    },
  );

  it("honours a narrowed coveredDates over the declared window", () => {
    const slices = coverageSlices(
      task({ dates: ["2027-03-05", "2027-03-06"], coveredDates: ["2027-03-05"] }),
    );
    expect(slices).toEqual([{ flightDate: "2027-03-05", program: "alaska" }]);
  });

  it("folds in slices proved by a returned offer, so coverage is never narrower than results", () => {
    // A returned offer is proof the source looked. Without this fold-in, an
    // adapter whose declared window drifts from what it actually queried would
    // strand rows as permanently unprunable.
    const slices = coverageSlices(
      task({
        dates: ["2027-03-05"],
        programs: ["alaska"],
        offers: [offer({ flightDate: "2027-03-09", program: "aeroplan" })],
      }),
    );
    expect(slices).toContainEqual({ flightDate: "2027-03-09", program: "aeroplan" });
  });
});

describe("prunable", () => {
  const previous = [
    offer({ flightDate: "2027-03-05", cabin: "business" }),
    offer({ flightDate: "2027-03-06", cabin: "business" }),
  ];

  it("deletes a covered find that was not reported again", () => {
    const gone = prunable(previous, [previous[0]!], [
      { flightDate: "2027-03-05", program: "alaska" },
      { flightDate: "2027-03-06", program: "alaska" },
    ]);
    expect(gone.map((g) => g.flightDate)).toEqual(["2027-03-06"]);
  });

  it("leaves an uncovered find alone", () => {
    // The date was never searched this run, so its absence means nothing.
    const gone = prunable(previous, [], [{ flightDate: "2027-03-05", program: "alaska" }]);
    expect(gone.map((g) => g.flightDate)).toEqual(["2027-03-05"]);
  });

  it("leaves a covered date's OTHER program alone", () => {
    const withAeroplan = [...previous, offer({ flightDate: "2027-03-05", program: "aeroplan" })];
    const gone = prunable(withAeroplan, [], [{ flightDate: "2027-03-05", program: "alaska" }]);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.program).toBe("alaska");
  });
});

describe("hashResult", () => {
  it("is stable for an unchanged result", () => {
    expect(hashResult(offer())).toBe(hashResult(offer()));
  });

  it("changes when segments do — which is why the STORED hash is the baseline", () => {
    // This is the fact that makes `loadPreviousForSource` return raw_hash rather
    // than recompute it. Enrichment replaces a summary's synthetic segment with
    // the real legs, so a recomputed baseline would differ from the identical
    // summary arriving on the next search, and the row would be rewritten —
    // discarding the enrichment every single time. See applyTask's own test.
    const summary = offer({ segments: [{ from: "SEA", to: "LAX", carrier: "AS" }] });
    const enriched = offer({
      segments: [{ from: "SEA", to: "LAX", carrier: "AS", flightNumber: "AS505" }],
    });
    expect(hashResult(summary)).not.toBe(hashResult(enriched));
  });
});

// ---------------------------------------------------------------------------
// applyTask against a stubbed D1.
//
// The stub is deliberately dumb: it answers the baseline SELECT with canned rows
// and records everything else. That is enough for the one property worth pinning
// here — which writes happen — without pretending to be SQLite.
// ---------------------------------------------------------------------------

interface StubbedRow extends Record<string, unknown> {
  raw_hash: string;
}

/** One row of a `price_history` write, unpacked from the JSON parameter the
 *  bulk writer binds it as. `m` is the miles cost; null marks a gone point. */
interface HistoryArg {
  k: string;
  d: string;
  p: string;
  c: string;
  s: string;
  m: number | null;
}

function stubDb(baseline: StubbedRow[]) {
  const inserts: unknown[][] = [];
  const deletes: unknown[][] = [];
  const history: HistoryArg[] = [];
  /** Every `.all()` read, so a test can assert on the baseline query's SHAPE
   *  and not only on what came back from it. */
  const reads: { sql: string; args: unknown[] }[] = [];

  const statement = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql,
      args,
      all: async () => {
        reads.push({ sql, args });
        return { results: sql.includes("SELECT") ? baseline : [] };
      },
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => null,
    }),
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: { sql: string; args: unknown[] }[]) => {
      for (const s of stmts) {
        if (s.sql.includes("INSERT INTO availability_snapshots")) inserts.push(s.args);
        else if (s.sql.includes("DELETE FROM availability_snapshots")) deletes.push(s.args);
        else if (s.sql.includes("INSERT INTO price_history"))
          history.push(...(JSON.parse(String(s.args[0])) as HistoryArg[]));
      }
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;

  return { db, inserts, deletes, history, reads };
}

/** The columns `loadPreviousForSource` selects, for one stored snapshot. */
const storedRow = (r: AvailabilityResult, rawHash: string): StubbedRow => ({
  origin: r.origin,
  destination: r.destination,
  flight_date: r.flightDate,
  program: r.program,
  cabin: r.cabin,
  seats_available: r.seatsAvailable,
  miles_cost: r.milesCost,
  cash_fees_cents: r.cashFeesCents,
  fees_currency: r.feesCurrency,
  is_direct: r.isDirect ? 1 : 0,
  segments_json: JSON.stringify(r.segments),
  source: r.source,
  source_fetched_at: r.sourceFetchedAt,
  transfer_currencies: JSON.stringify(r.bookableWith ?? []),
  duration_minutes: r.durationMinutes ?? null,
  booking_url: r.bookingUrl ?? null,
  raw_hash: rawHash,
  source_record_id: r.sourceRecordId ?? null,
  detail_level: r.detailLevel ?? "itinerary",
  // The honest stop count, which is what `rowToResult` reads. Nullable on
  // purpose: NULL is "nobody said", never a guess.
  stop_count: r.stops ?? null,
  airlines: r.airlines?.length ? JSON.stringify(r.airlines) : null,
  direct_airlines: r.directAirlines?.length ? JSON.stringify(r.directAirlines) : null,
  direct_miles_cost: r.directMilesCost ?? null,
});

describe("applyTask — write-on-change", () => {
  const summary = offer({
    source: "seatsaero",
    sourceRecordId: "avail-1",
    detailLevel: "summary",
    segments: [{ from: "SEA", to: "LAX", carrier: "AS", cabin: "business" }],
  });
  const seatsAeroTask = () =>
    task({ source: "seatsaero", offers: [summary], programs: ["alaska"] });

  it("writes nothing when the source's claim is unchanged", async () => {
    // The cheapest smoke test this pipeline has. It covers price_history too:
    // a point per SEARCH rather than per change would turn the series into a
    // sample of how often the cron ran.
    const { db, inserts, history } = stubDb([storedRow(summary, hashResult(summary))]);
    const out = await applyTask(db, "run-1", seatsAeroTask());
    expect(inserts).toHaveLength(0);
    expect(history).toHaveLength(0);
    expect(out.snapshotsWritten).toBe(0);
  });

  it("records the disappearance as a point, not as the end of the series", async () => {
    // The whole reason price_history exists. The DELETE below is unscoped in
    // time — it takes every snapshot the slot ever had — so unless this point is
    // written, a series ends exactly when it becomes interesting.
    const { db, deletes, history } = stubDb([storedRow(summary, hashResult(summary))]);
    const out = await applyTask(
      db,
      "run-gone",
      task({ source: "seatsaero", offers: [], programs: ["alaska"] }),
    );

    expect(deletes).toHaveLength(1);
    expect(out.snapshotsPruned).toBe(1);
    expect(history).toHaveLength(1);
    // NULL, not zero: the source covered the slot and reported no award. A zero
    // would read as a free seat.
    expect(history[0]!.m).toBeNull();
    expect(history[0]!.k).toBe("SEA-LAX-2027-03-05");
  });

  it("counts pruned snapshots off the deletes alone", async () => {
    // The history write rides in the SAME batch as the DELETE, deliberately —
    // one transaction, so a price cannot be destroyed without the record of its
    // disappearance landing with it. That puts its inserted-row count in the
    // same results array, and tallying the whole array would report two
    // snapshots pruned where one row was deleted.
    const { db, deletes, history } = stubDb([storedRow(summary, hashResult(summary))]);
    const out = await applyTask(
      db,
      "run-gone",
      task({ source: "seatsaero", offers: [], programs: ["alaska"] }),
    );
    expect(history).toHaveLength(1);
    expect(out.snapshotsPruned).toBe(deletes.length);
  });

  it("records nothing for a slice the task never covered", async () => {
    // No coverage claim, no prune, and so nothing observed to write down.
    const { db, deletes, history } = stubDb([storedRow(summary, hashResult(summary))]);
    await applyTask(
      db,
      "run-blocked",
      task({ source: "seatsaero", status: "blocked", offers: [], programs: ["alaska"] }),
    );
    expect(deletes).toHaveLength(0);
    expect(history).toHaveLength(0);
  });

  it("records a price point for each snapshot it writes", async () => {
    const { db, inserts, history } = stubDb([]);
    await applyTask(db, "run-1", seatsAeroTask(), 1_700_000_000_000);
    expect(inserts).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      k: "SEA-LAX-2027-03-05",
      p: "alaska",
      c: "business",
      s: "seatsaero",
      m: summary.milesCost,
    });
  });

  it("reads its baseline with the EXACT pair test, not just the airport sets", async () => {
    // A data-destroying trap, pinned. `loadPreviousForSource` carries indexable
    // `origin IN (...)`/`destination IN (...)` clauses so it can seek
    // idx_snap_route_date instead of scanning — but those are a SUPERSET of the
    // pairs the task touched, and `prunable` filters on (flightDate, program)
    // only. It has no pair test of its own.
    //
    // So if the exact `(origin || '-' || destination) IN (...)` residual is ever
    // "simplified" away as redundant, this query starts returning rows for pairs
    // the task never asked about, `prunable` sees them as covered-and-missing,
    // and applyTask DELETES them. Touch SFO->NRT, OAK->NRT and SFO->HND and the
    // cross product hands you OAK->HND — a real pair, another search's find.
    const { db, reads } = stubDb([]);
    await applyTask(
      db,
      "run-1",
      task({
        source: "seatsaero",
        origin: "SFO",
        destination: "NRT",
        programs: ["alaska"],
        offers: [
          offer({ source: "seatsaero", origin: "SFO", destination: "HND" }),
          offer({ source: "seatsaero", origin: "OAK", destination: "NRT" }),
        ],
      }),
    );
    const baseline = reads.find((r) => r.sql.includes("FROM availability_snapshots"));
    expect(baseline).toBeDefined();
    expect(baseline!.sql).toContain("(origin || '-' || destination) IN");
    expect(baseline!.sql).toContain("(s.origin || '-' || s.destination) IN");
    // And the pairs bound are the touched ones, never their cross product.
    expect(baseline!.args).toContain("SFO-NRT");
    expect(baseline!.args).toContain("SFO-HND");
    expect(baseline!.args).toContain("OAK-NRT");
    expect(baseline!.args).not.toContain("OAK-HND");
    // D1 refuses a query over 100 bound parameters, and this one binds its sets
    // twice. The narrowing is dropped rather than the correctness above it.
    expect(baseline!.args.length).toBeLessThanOrEqual(100);
  });

  it("STILL writes nothing when the stored row has been enriched since", async () => {
    // The regression this whole feature turns on. The stored row now carries
    // real legs and an itinerary detail_level; the search that follows still
    // reports the same synthetic summary. Recomputing the baseline hash would
    // see a difference and rewrite the row, throwing the enrichment away — on
    // every search, forever. The stored raw_hash still describes what seats.aero
    // said, so nothing is written and the enrichment survives.
    const enrichedRow = storedRow(
      {
        ...summary,
        detailLevel: "itinerary",
        durationMinutes: 1566,
        bookingUrl: "https://www.alaskaair.com/search",
        segments: [
          { from: "SEA", to: "SFO", carrier: "AS", flightNumber: "AS505" },
          { from: "SFO", to: "LAX", carrier: "AS", flightNumber: "AS12" },
        ],
      },
      // Unchanged: enrichment never rewrites raw_hash.
      hashResult(summary),
    );

    const { db, inserts, deletes } = stubDb([enrichedRow]);
    const out = await applyTask(db, "run-2", seatsAeroTask());

    expect(inserts).toHaveLength(0);
    expect(out.snapshotsWritten).toBe(0);
    // And it is not pruned either — the summary re-reported it, so it is current.
    expect(deletes).toHaveLength(0);
  });

  it("writes again when the source's claim really does change", async () => {
    // The other half: enrichment must not make a row immortal. A price move
    // hashes differently and lands a fresh summary row, which correctly reverts
    // the find to 'summary' — the stored itinerary was quoted at the old price.
    const { db, inserts } = stubDb([
      storedRow(summary, hashResult({ ...summary, milesCost: 999_999 })),
    ]);
    const out = await applyTask(db, "run-3", seatsAeroTask());
    expect(inserts).toHaveLength(1);
    expect(out.snapshotsWritten).toBe(1);
  });

  // The INSERT's trailing binds, in the order the statement lists them:
  //   source_record_id, detail_level, stop_count, airlines,
  //   direct_airlines, direct_miles_cost
  const TAIL = 6;
  const tail = (insert: unknown[]) => insert.slice(-TAIL);

  it("persists the enrichment handle and the detail level", async () => {
    const { db, inserts } = stubDb([]);
    await applyTask(db, "run-4", seatsAeroTask());
    expect(inserts).toHaveLength(1);
    expect(tail(inserts[0]!).slice(0, 2)).toEqual(["avail-1", "summary"]);
  });

  it("defaults a source that says nothing to 'itinerary'", async () => {
    // An enriched row arrives with real legs, and so does anything but
    // seats.aero's Cached-Search summaries — "itinerary" is the right default.
    const { db, inserts } = stubDb([]);
    await applyTask(db, "run-5", task({ offers: [offer()] }));
    expect(tail(inserts[0]!).slice(0, 2)).toEqual([null, "itinerary"]);
  });

  it("writes NULL stop_count when the source never said how many stops", async () => {
    // A non-direct summary row has no stop count on the wire at all. Guessing
    // one and storing it as data would make "connecting, routing unknown"
    // indistinguishable from "one stop, we checked".
    const { db, inserts } = stubDb([]);
    await applyTask(
      db,
      "run-6",
      task({ source: "seatsaero", offers: [offer({ isDirect: false, stops: undefined })] }),
    );
    expect(tail(inserts[0]!)[2]).toBeNull();
  });

  it("keeps the carriers and the nonstop price the summary row reported", async () => {
    const { db, inserts } = stubDb([]);
    await applyTask(
      db,
      "run-7",
      task({
        offers: [
          offer({
            airlines: ["AS", "CX", "JL"],
            directAirlines: ["JL"],
            directMilesCost: 37500,
          }),
        ],
      }),
    );
    expect(tail(inserts[0]!).slice(3)).toEqual(['["AS","CX","JL"]', '["JL"]', 37500]);
  });
});

describe("applyTask — a task that asked about several city pairs", () => {
  // One seats.aero call takes comma-delimited airports, so a multi-airport
  // route covers a whole cross product in a single query. Everything
  // below is about the coverage claim that follows from that, because getting it
  // wrong is the one error this pipeline treats as unrecoverable: over-claiming
  // hard-deletes real finds.
  const PAIRS = [
    { origin: "SEA", destination: "NRT" },
    { origin: "SEA", destination: "HND" },
    { origin: "PDX", destination: "NRT" },
    { origin: "PDX", destination: "HND" },
  ];

  const multi = (t: Partial<SourceTaskReport> = {}) =>
    task({
      source: "seatsaero",
      taskKey: "seatsaero:PDX+SEA-HND+NRT:2027-03-05..2027-03-05",
      origin: "SEA",
      destination: "NRT",
      routes: PAIRS,
      programs: ["alaska"],
      ...t,
    });

  it("claims coverage for every pair it asked about, including the empty ones", () => {
    // The load-bearing case. seats.aero answered a query that covered PDX->HND
    // and returned nothing for it — that is a real `empty`, and claiming it is
    // what allows a find that genuinely vanished there to be pruned later.
    // Claiming only the pairs that returned rows would strand those rows as
    // permanently unprunable.
    const slices = coverageSlices(multi({ offers: [] }));
    expect(slices).toHaveLength(1); // one (date, program)
    expect(routesTouched(multi(), [])).toHaveLength(4);
  });

  it("NEVER binds a comma-joined airport into the baseline read", async () => {
    // The bug this whole `routes` field exists to make impossible. The baseline
    // query's pair list is the one thing standing between a task and pruning a
    // pair it never touched, so an "airport" called `SEA,PDX` reaching it would
    // match no stored row — leaving the real pairs' rows outside the baseline
    // and so invisible to both write-on-change and the pruner.
    const { db, reads } = stubDb([]);
    await applyTask(db, "run-multi", multi({ offers: [] }));
    const args = reads.flatMap((r) => r.args).map(String);
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(a).not.toContain(",");
    expect([...new Set(args.filter((a) => a.includes("-") && !a.startsWith("20")))].sort()).toEqual([
      "PDX-HND",
      "PDX-NRT",
      "SEA-HND",
      "SEA-NRT",
    ]);
  });

  it("claims NOTHING for any pair when the task failed", async () => {
    // The status gate sits upstream of the pair fan-out, and must stay there: a
    // blocked call covering four pairs looked at none of them.
    const { db, inserts, deletes, reads } = stubDb([]);
    const out = await applyTask(db, "run-blocked", multi({ status: "blocked", offers: [] }));
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    // It does not even read the baseline: the gate is upstream of everything.
    expect(reads).toHaveLength(0);
    expect(out.offersKept).toBe(0);
  });

  it("folds in a pair the source answered with but nobody asked for", async () => {
    // Co-terminal substitution still works on top of the cross product — the two
    // mechanisms compose rather than replacing each other.
    const surprise = offer({ origin: "SEA", destination: "KIX", source: "seatsaero" });
    const touched = routesTouched(multi(), [surprise]);
    expect(touched).toHaveLength(5);
    expect(touched.some((r) => r.destination === "KIX")).toBe(true);
  });

  it("falls back to the single pair when a task names no routes", () => {
    // Every source, and every search before multi-airport routes.
    expect(routesTouched(task(), [])).toEqual([{ origin: "SEA", destination: "LAX" }]);
  });
});
