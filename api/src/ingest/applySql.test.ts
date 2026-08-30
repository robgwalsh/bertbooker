import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The ingest statements, run against a real SQLite engine.
 *
 * Everything else in `apply.test.ts` goes through `stubDb`, which records SQL
 * and never executes it — so every assertion there is a string match. That is
 * the right tool for "did this bind the pairs it touched", and the wrong one for
 * "does this UPSERT reproduce a fresh row", which is a claim about what SQLite
 * DOES. A string match on the SET list passes forever while the semantics rot.
 *
 * This is the one place the semantics themselves are pinned. It reads the real
 * migration files and the real statement out of `apply.ts` rather than a copy,
 * so an edit to either is exercised here rather than drifting from it.
 *
 * `node:sqlite` needs Node >= 22.5 and this repo's `engines` says >= 20, so the
 * import could fail on a conforming runtime. It is NOT guarded: a silently
 * skipped parity test is worse than none, and every machine and CI runner this
 * project uses is well past 22.5.
 */

/** `availability_snapshots` as 0001 declares it, minus 0012's dropped columns
 *  and the `programs` foreign key — this database has no reference tables and
 *  the key is not what is under test. */
function snapshotDdl(): string {
  const init = readFileSync("migrations/0001_init.sql", "utf8");
  const from = init.slice(init.indexOf("CREATE TABLE IF NOT EXISTS availability_snapshots"));
  return from
    .slice(0, from.indexOf("\n);") + 3)
    .replace(/cash_price_cents\s+INTEGER,?/, "")
    .replace(/cash_price_currency\s+TEXT,?/, "")
    .replace(/program\s+TEXT NOT NULL REFERENCES programs\(code\)/, "program TEXT NOT NULL");
}

/** The UPSERT out of `apply.ts` itself, so this cannot pin a stale copy. */
function upsertSql(): string {
  const src = readFileSync("api/src/ingest/apply.ts", "utf8");
  const start = src.indexOf("`INSERT INTO availability_snapshots");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start + 1, src.indexOf("`", start + 1));
}

const PRICE_HISTORY_DDL = `CREATE TABLE price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, route_key TEXT NOT NULL,
  flight_date TEXT NOT NULL, program TEXT NOT NULL, cabin TEXT NOT NULL,
  source TEXT NOT NULL, miles_cost INTEGER, seats_available INTEGER,
  cash_fees_cents INTEGER, fees_currency TEXT, source_fetched_at INTEGER,
  captured_at INTEGER NOT NULL)`;

describe("migration 0013 + 0014 — current-only", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(snapshotDdl());
    db.exec(PRICE_HISTORY_DDL);
    // The four 0001/0005 indexes the migration expects to find and drop.
    db.exec("CREATE INDEX idx_snap_lookup ON availability_snapshots (route_key, program, cabin, captured_at)");
    db.exec("CREATE INDEX idx_snap_captured ON availability_snapshots (captured_at)");
    db.exec("CREATE INDEX idx_snap_source_lookup ON availability_snapshots (route_key, program, cabin, source, captured_at DESC)");
    db.exec("CREATE INDEX idx_snap_route_date ON availability_snapshots (origin, destination, flight_date, program, cabin, source, captured_at)");
  });

  const seed = (miles: number, capturedAt: number, enrichedAt: number | null) =>
    db
      .prepare(
        `INSERT INTO availability_snapshots
           (route_key, origin, destination, flight_date, program, cabin,
            seats_available, miles_cost, source, source_fetched_at, raw_hash,
            captured_at, enriched_at, detail_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "SFO-NRT-2026-10-08", "SFO", "NRT", "2026-10-08", "alaska", "business",
        2, miles, "seatsaero", 1, `h${miles}`, capturedAt, enrichedAt, "itinerary",
      );

  const migrate = () => {
    db.exec(readFileSync("migrations/0013_snapshot_dedupe.sql", "utf8"));
    db.exec(readFileSync("migrations/0014_snapshot_current_only.sql", "utf8"));
  };

  it("keeps the newest row per slot and drops the rest", () => {
    seed(60_000, 1_000, null);
    seed(55_000, 2_000, null);
    migrate();
    const rows = db.prepare("SELECT miles_cost FROM availability_snapshots").all();
    expect(rows).toEqual([{ miles_cost: 55_000 }]);
  });

  it("breaks a captured_at TIE on id, keeping the latest INSERT", () => {
    // The case the tie-break exists for, and it is the NORMAL case rather than a
    // corner: captured_at defaults to unixepoch() * 1000, so every row of one
    // ingest batch shares a value. MAX(captured_at) alone would pick arbitrarily.
    seed(60_000, 1_000, null);
    seed(55_000, 1_000, null);
    seed(50_000, 1_000, null);
    migrate();
    const rows = db.prepare("SELECT id, miles_cost FROM availability_snapshots").all();
    expect(rows).toEqual([{ id: 3, miles_cost: 50_000 }]);
  });

  it("leaves every superseded observation in price_history before deleting it", () => {
    seed(60_000, 1_000, null);
    seed(55_000, 2_000, null);
    migrate();
    const kept = db
      .prepare("SELECT miles_cost FROM price_history ORDER BY miles_cost")
      .all();
    expect(kept).toEqual([{ miles_cost: 55_000 }, { miles_cost: 60_000 }]);
  });

  it("does not duplicate a point price_history already holds", () => {
    seed(60_000, 1_000, null);
    // Same observation, written by priceStatements a few hundred ms later — the
    // clock skew that made an exact captured_at match report 7,231 false orphans.
    db.prepare(
      `INSERT INTO price_history
         (route_key, flight_date, program, cabin, source, miles_cost,
          seats_available, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("SFO-NRT-2026-10-08", "2026-10-08", "alaska", "business", "seatsaero", 60_000, 2, 1_437);
    migrate();
    expect(db.prepare("SELECT COUNT(*) AS n FROM price_history").get()).toEqual({ n: 1 });
  });

  it("drops every index carrying captured_at and leaves the two that matter", () => {
    migrate();
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'availability_snapshots'
            AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["idx_snap_route_date", "idx_snap_slot"]);
  });

  it("enforces one row per slot afterwards", () => {
    seed(60_000, 1_000, null);
    migrate();
    expect(() => seed(55_000, 2_000, null)).toThrow(/UNIQUE/i);
  });
});

describe("the ingest UPSERT", () => {
  let db: DatabaseSync;
  let write: (miles: number, hash: string, detail: string) => void;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(snapshotDdl());
    db.exec("CREATE UNIQUE INDEX idx_snap_slot ON availability_snapshots (route_key, program, cabin)");
    const stmt = db.prepare(upsertSql());
    write = (miles, hash, detail) =>
      stmt.run(
        "SFO-NRT-2026-10-08", "SFO", "NRT", "2026-10-08", "alaska", "business",
        2, miles, 0, "USD", 1, "[]", "seatsaero", 1, hash, "[]", null, null,
        "run1", null, detail, null, null, null, null,
      );
  });

  it("replaces the slot in place rather than growing a second row", () => {
    write(60_000, "h1", "summary");
    const first = db.prepare("SELECT id FROM availability_snapshots").get();
    write(45_000, "h2", "summary");
    const rows = db.prepare("SELECT id, miles_cost FROM availability_snapshots").all();
    expect(rows).toEqual([{ id: first!.id, miles_cost: 45_000 }]);
  });

  it("REVERTS an enrichment when the price moves", () => {
    // The behaviour that came free while this was an INSERT: a fresh row took
    // the column defaults, so an enriched find dropped back to the source's own
    // summary. An upsert has to reproduce it deliberately, and omitting either
    // half leaves last week's itinerary attached to this week's price.
    write(60_000, "h1", "summary");
    db.exec(
      `UPDATE availability_snapshots
          SET enriched_at = 555, detail_level = 'itinerary', segments_json = '[real legs]'`,
    );
    write(45_000, "h2", "summary");
    expect(
      db.prepare("SELECT enriched_at, detail_level, segments_json FROM availability_snapshots").get(),
    ).toEqual({ enriched_at: null, detail_level: "summary", segments_json: "[]" });
  });

  it("moves captured_at forward on every write", () => {
    write(60_000, "h1", "summary");
    db.exec("UPDATE availability_snapshots SET captured_at = 1");
    write(45_000, "h2", "summary");
    const { captured_at } = db.prepare("SELECT captured_at FROM availability_snapshots").get()!;
    expect(Number(captured_at)).toBeGreaterThan(1);
  });
});
