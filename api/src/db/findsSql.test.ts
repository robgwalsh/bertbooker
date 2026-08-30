import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The ingest statements, run against a real SQLite engine.
 *
 * Everything else in `features/search/apply.test.ts` goes through `stubDb`, which records SQL
 * and never executes it — so every assertion there is a string match. That is
 * the right tool for "did this bind the pairs it touched", and the wrong one for
 * "does this UPSERT reproduce a fresh row", which is a claim about what SQLite
 * DOES. A string match on the SET list passes forever while the semantics rot.
 *
 * This is the one place the semantics themselves are pinned. It reads the real
 * migration and the real statements out of `db/finds.ts` rather than a copy, so an
 * edit to either is exercised here rather than drifting from it.
 *
 * `node:sqlite` needs Node >= 22.5 and this repo's `engines` says >= 20, so the
 * import could fail on a conforming runtime. It is NOT guarded: a silently
 * skipped parity test is worse than none.
 */

/** `finds` as 0001 declares it, minus the `programs` foreign key — this database
 *  has no reference tables and the key is not what is under test. */
function findsDdl(): string {
  const init = readFileSync("migrations/0001_init.sql", "utf8");
  const from = init.slice(init.indexOf("CREATE TABLE IF NOT EXISTS finds"));
  return from
    .slice(0, from.indexOf("WITHOUT ROWID;") + "WITHOUT ROWID;".length)
    .replace(/program\s+TEXT\s+NOT NULL REFERENCES programs\(code\)/, "program TEXT NOT NULL");
}

/** A statement out of `db/finds.ts` itself, so this cannot pin a stale copy. */
function statementFrom(marker: string): string {
  const src = readFileSync("api/src/db/finds.ts", "utf8");
  const start = src.indexOf("`" + marker);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start + 1, src.indexOf("`", start + 1));
}

describe("the finds table", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(findsDdl());
  });

  /**
   * The design claim the whole schema rests on: ONE b-tree. An index added to
   * this table is paid for on every ingest write, against a 100,000-row daily
   * write budget — so a new one is a deliberate trade, not a tidy-up, and this
   * is where it has to be argued.
   */
  it("carries no index but its primary key", () => {
    const idx = db.prepare("PRAGMA index_list('finds')").all();
    expect(idx.map((i) => i.origin)).toEqual(["pk"]);
  });

  /** WITHOUT ROWID is what makes the table and its key one structure rather than
   *  two — the difference between one row written per changed find and two. */
  it("is WITHOUT ROWID", () => {
    expect(() => db.prepare("SELECT rowid FROM finds").all()).toThrow(/no such column/i);
  });

  it("is unique on the slot", () => {
    const ins = db.prepare(
      `INSERT INTO finds (origin, destination, flight_date, program, cabin,
         seats_available, miles_cost, source_fetched_at, raw_hash)
       VALUES ('SFO','NRT','2026-10-08','alaska','business',2,?,1,'h')`,
    );
    ins.run(60_000);
    expect(() => ins.run(55_000)).toThrow(/UNIQUE|constraint/i);
  });
});

describe("the ingest UPSERT", () => {
  let db: DatabaseSync;
  let write: (miles: number, hash: string, detail: string) => void;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(findsDdl());
    const stmt = db.prepare(statementFrom("INSERT INTO finds"));
    write = (miles, hash, detail) =>
      stmt.run(
        "SFO", "NRT", "2026-10-08", "alaska", "business",
        2, miles, 0, "USD", 1, "[]", 1, hash, "[]", null, null,
        null, detail, null, null, null, null,
      );
  });

  it("replaces the slot in place rather than growing a second row", () => {
    write(60_000, "h1", "summary");
    write(45_000, "h2", "summary");
    expect(db.prepare("SELECT miles_cost FROM finds").all()).toEqual([{ miles_cost: 45_000 }]);
  });

  it("REVERTS an enrichment when the price moves", () => {
    // The behaviour that came free while this was an INSERT: a fresh row took
    // the column defaults, so an enriched find dropped back to the source's own
    // summary. An upsert has to reproduce it deliberately, and omitting either
    // half leaves last week's itinerary attached to this week's price.
    write(60_000, "h1", "summary");
    db.exec(
      `UPDATE finds
          SET enriched_at = 555, detail_level = 'itinerary', segments_json = '[real legs]'`,
    );
    write(45_000, "h2", "summary");
    expect(
      db.prepare("SELECT enriched_at, detail_level, segments_json FROM finds").get(),
    ).toEqual({ enriched_at: null, detail_level: "summary", segments_json: "[]" });
  });
});

describe("the ingest prune", () => {
  /** The DELETE names the whole primary key, so it is an exact one-row hit and
   *  can never take a neighbouring cabin or program with it. */
  it("deletes exactly the slot it names", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(findsDdl());
    const ins = db.prepare(
      `INSERT INTO finds (origin, destination, flight_date, program, cabin,
         seats_available, miles_cost, source_fetched_at, raw_hash)
       VALUES ('SFO','NRT','2026-10-08',?,?,2,60000,1,'h')`,
    );
    ins.run("alaska", "business");
    ins.run("alaska", "economy");
    ins.run("aeroplan", "business");

    const res = db
      .prepare(statementFrom("DELETE FROM finds"))
      .run("SFO", "NRT", "2026-10-08", "alaska", "business");
    expect(res.changes).toBe(1);
    expect(db.prepare("SELECT program, cabin FROM finds ORDER BY program, cabin").all()).toEqual([
      { program: "aeroplan", cabin: "business" },
      { program: "alaska", cabin: "economy" },
    ]);
  });
});
