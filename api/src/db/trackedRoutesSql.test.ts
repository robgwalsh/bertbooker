import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The `tracked_routes` writers, PREPARED against a real SQLite engine.
 *
 * This exists because of a bug that shipped: `PATCH /api/tracked-routes/:id` set
 * a `cabin` column that `0001_init.sql` does not declare, so every route edit —
 * the edit dialog and every filter chip in the Routes header — answered 500. It
 * was invisible to `tsc` (SQL is a string), invisible to the other tests (they
 * stub D1 and assert on the string), and invisible to the UI suite (which may
 * not write). Nothing in the repo compared the columns a statement names against
 * the columns the table has.
 *
 * `prepare()` is the whole check: SQLite resolves every column name at prepare
 * time, so a statement naming a column the schema lacks throws here rather than
 * on somebody's next save. It reads the real migration and the real statements
 * out of `db/trackedRoutes.ts`, so an edit to either is exercised rather than
 * drifting from a copy — the same arrangement `findsSql.test.ts` uses.
 *
 * `node:sqlite` needs Node >= 22.5 and this repo's `engines` says >= 20, so the
 * import could fail on a conforming runtime. It is NOT guarded: a silently
 * skipped parity test is worse than none.
 */

/** `tracked_routes` as 0001 declares it. */
function trackedRoutesDdl(): string {
  const init = readFileSync("migrations/0001_init.sql", "utf8");
  const from = init.slice(init.indexOf("CREATE TABLE IF NOT EXISTS tracked_routes"));
  return from.slice(0, from.indexOf("\n);") + "\n);".length);
}

/** A statement out of `db/trackedRoutes.ts` itself, so this cannot pin a stale
 *  copy. The marker is the first line of the SQL, which is unique per statement. */
function statementFrom(marker: string): string {
  const src = readFileSync("api/src/db/trackedRoutes.ts", "utf8");
  const start = src.indexOf("`" + marker);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start + 1, src.indexOf("`", start + 1));
}

describe("the tracked_routes writers name columns the table has", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(trackedRoutesDdl());
  });

  it("prepares the INSERT", () => {
    expect(() => db.prepare(statementFrom("INSERT INTO tracked_routes"))).not.toThrow();
  });

  /** The one that regressed. `cabin` is not a column; `cabins` is. */
  it("prepares the UPDATE", () => {
    expect(() => db.prepare(statementFrom("UPDATE tracked_routes\n"))).not.toThrow();
  });

  it("would have caught the bug: a stray column is a prepare-time error", () => {
    expect(() =>
      db.prepare("UPDATE tracked_routes SET cabin = ? WHERE id = ?"),
    ).toThrow(/no such column/i);
  });

  /**
   * The two writers must round-trip a whole route, because the UPDATE is a
   * whole-row write rather than a per-column patch — the merge upstream hands it
   * every value, so a column missing from one and present in the other is a
   * silent divergence rather than a compile error.
   */
  it("round-trips a route through both statements", () => {
    const insert = db.prepare(statementFrom("INSERT INTO tracked_routes"));
    const id = (
      insert.get(
        "SFO",
        "NRT",
        '["SFO"]',
        '["NRT"]',
        null,
        "2026-11-01",
        "2026-11-20",
        '["business"]',
        2,
        null,
        0,
        null,
        0,
        0,
        null,
        null,
        5,
      ) as { id: number }
    ).id;

    db.prepare(statementFrom("UPDATE tracked_routes\n")).run(
      "PDX",
      "HND",
      '["PDX"]',
      '["HND"]',
      '["ICN"]',
      "2026-12-01",
      "2026-12-10",
      '["economy"]',
      null,
      4,
      1,
      99_000,
      1,
      1,
      "someone@example.com",
      '["new"]',
      9,
      1,
      null,
      id,
    );

    const row = db.prepare("SELECT * FROM tracked_routes WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    expect(row.origin).toBe("PDX");
    expect(row.origins).toBe('["PDX"]');
    expect(row.via).toBe('["ICN"]');
    expect(row.cabins).toBe('["economy"]');
    expect(row.min_seats).toBe(4);
    expect(row.point_limit).toBe(99_000);
    expect(row.round_trip).toBe(1);
    expect(row.alert_on).toBe('["new"]');
    // A settings change is a fresh start for the back-off.
    expect(row.alert_consecutive_failures).toBe(0);
  });
});
