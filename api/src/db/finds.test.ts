import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { FilteredRoute, FindsScope, ScopedRoute } from "./finds.js";
import { findsFrom, routeFindsScope, withinRouteScope } from "./finds.js";
import type { MatchableRoute } from "../../../shared/src/match/routeMatch.js";
import { routeMatcher } from "../../../shared/src/match/routeMatch.js";

/**
 * The scope is the one part of the read path that can lose data silently.
 *
 * `findsFrom` used to collapse every snapshot in the database to answer about
 * one route — 171,471 rows read for a route whose entire input was 23. Narrowing
 * that is where nearly all of this app's D1 bill went, and the narrowing is only
 * safe while it stays a **superset** of everything `routeMatcher` accepts. A
 * branch added there without a matching widening in `routeFindsScope` drops
 * finds out of the Routes page and out of alert digests — and a digest that finds
 * nothing sends no mail, so nothing would report it.
 *
 * So these tests RUN the scope, against a real SQLite engine, and check what it
 * admits against what `routeMatcher` accepts. They deliberately do not
 * re-implement either side: a second copy of the match rule is exactly what
 * `routeMatch.ts`'s docblock exists to prevent, and it would agree with itself
 * while both drifted from the thing that ships.
 *
 * This replaced a helper that split `scope.binds` by counting `?` in a `where`
 * array whose shape it had memorised. That worked while the shape was three
 * fixed clauses and became a liar the moment it was a disjunction — it read the
 * cabin binds as destinations and still passed. `node:sqlite` costs nothing here
 * and cannot be fooled that way; see `ingest/applySql.test.ts`, which uses it
 * for the same reason.
 */

/** Only the columns the scope constrains. Every one is NOT NULL in 0001, which
 *  is the property `pushFilters` relies on to match the matcher's reading. */
const DDL = `CREATE TABLE finds (
  origin              TEXT NOT NULL,
  destination         TEXT NOT NULL,
  flight_date         TEXT NOT NULL,
  cabin               TEXT NOT NULL,
  seats_available     INTEGER NOT NULL,
  miles_cost          INTEGER NOT NULL,
  is_direct           INTEGER NOT NULL,
  transfer_currencies TEXT NOT NULL
)`;

interface Row {
  origin: string;
  destination: string;
  flight_date: string;
  cabin: string;
  seats_available: number;
  miles_cost: number;
  is_direct: number;
  transfer_currencies: string;
}

/** A find that passes every filter, so a test that says nothing about cabins is
 *  asking only about airports and dates. */
const find = (o: Partial<Row> = {}): Row => ({
  origin: "PIT",
  destination: "BOS",
  flight_date: "2026-10-08",
  cabin: "business",
  seats_available: 4,
  miles_cost: 25_000,
  is_direct: 1,
  transfer_currencies: '["chase_ur","amex_mr"]',
  ...o,
});

const route = (o: Partial<FilteredRoute> = {}): FilteredRoute => ({
  origin: "PIT",
  destination: "BOS",
  origins: null,
  destinations: null,
  via: null,
  date_start: "2026-10-08",
  date_end: "2026-10-09",
  round_trip: 0,
  ...o,
});

/** Which of these rows does the scope's own SQL return? Runs the real text and
 *  the real binds — an unscoped scope produces no WHERE and returns them all,
 *  exactly as it does against D1. */
function admitted(scope: FindsScope, rows: Row[]): Row[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(DDL);
    const insert = db.prepare(
      `INSERT INTO finds
         (origin, destination, flight_date, cabin, seats_available, miles_cost,
          is_direct, transfer_currencies)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.origin,
        r.destination,
        r.flight_date,
        r.cabin,
        r.seats_available,
        r.miles_cost,
        r.is_direct,
        r.transfer_currencies,
      );
    }
    const from = findsFrom(scope);
    return db
      .prepare(`SELECT origin, destination, flight_date, cabin, seats_available,
                       miles_cost, is_direct, transfer_currencies ${from.sql}`)
      .all(...(from.binds as (string | number)[])) as unknown as Row[];
  } finally {
    db.close();
  }
}

/** Would the scope admit this one find? */
function admits(scope: FindsScope, origin: string, destination: string, date: string): boolean {
  const row = find({ origin, destination, flight_date: date });
  return admitted(scope, [row]).length === 1;
}

describe("routeFindsScope — the superset property, one witness per branch", () => {
  it("admits the forward branch", () => {
    const scope = routeFindsScope([route()]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "PIT", "BOS", "2026-10-09")).toBe(true);
  });

  it("admits every pair of a multi-airport route", () => {
    // MEMBERSHIP, not equality — the same rule the SQL predicate's json_each
    // clauses enforce. A SEA/PDX -> NRT/HND route has four real pairs.
    const scope = routeFindsScope([
      route({ origins: '["SEA","PDX"]', destinations: '["NRT","HND"]' }),
    ]);
    for (const o of ["SEA", "PDX"]) {
      for (const d of ["NRT", "HND"]) {
        expect(admits(scope, o, d, "2026-10-08")).toBe(true);
      }
    }
  });

  it("admits the round-trip branch's REVERSED legs", () => {
    // The search deliberately gathered BOS->PIT alongside PIT->BOS in one call.
    // Without this widening those return legs would be stored, claimed as
    // covered, and invisible — the exact "looks like no award space" failure.
    const scope = routeFindsScope([route({ round_trip: 1 })]);
    expect(admits(scope, "BOS", "PIT", "2026-10-08")).toBe(true);
  });

  it("does NOT widen to the reversed legs on a one-way route", () => {
    // Tightness, not just correctness: this is where the saving comes from. A
    // scope that admitted everything would be trivially a superset and worth
    // nothing.
    const scope = routeFindsScope([route()]);
    expect(admits(scope, "BOS", "PIT", "2026-10-08")).toBe(false);
  });

  it("admits both hub legs of a via route", () => {
    const scope = routeFindsScope([
      route({ destination: "HND", via: '["DTW","YYZ"]', date_end: "2026-10-20" }),
    ]);
    // First leg: an origin to a hub.
    expect(admits(scope, "PIT", "DTW", "2026-10-10")).toBe(true);
    expect(admits(scope, "PIT", "YYZ", "2026-10-10")).toBe(true);
    // Second leg: a hub to a destination.
    expect(admits(scope, "DTW", "HND", "2026-10-10")).toBe(true);
    // And the direct pair is still asked every search, so it must still match.
    expect(admits(scope, "PIT", "HND", "2026-10-10")).toBe(true);
  });

  it("admits a second hub leg departing the day AFTER the window closes", () => {
    // An overnight in the hub on the last gathered date is a real journey, and
    // `routeMatcher` widens exactly this branch by a day. The scope widens
    // unconditionally, which is why this passes for a route with no hubs too.
    const scope = routeFindsScope([
      route({ destination: "HND", via: '["DTW"]', date_end: "2026-10-20" }),
    ]);
    expect(admits(scope, "DTW", "HND", "2026-10-21")).toBe(true);
    expect(admits(scope, "DTW", "HND", "2026-10-22")).toBe(false);
  });

  it("excludes dates outside the window", () => {
    const scope = routeFindsScope([route()]);
    expect(admits(scope, "PIT", "BOS", "2026-10-07")).toBe(false);
    expect(admits(scope, "PIT", "BOS", "2026-10-11")).toBe(false);
  });

  it("admits each route's own finds, and NOT the cross product of them", () => {
    // What the union form could not express, and the whole reason for the
    // per-route shape. Measured on production, this cross product was the
    // difference between returning 7,049 rows and returning 1,591: a year-long
    // PIT->HND route widened the window that a three-day PIT->BOS route was read
    // through, and lent it its airports.
    const scope = routeFindsScope([
      route({ date_start: "2026-10-08", date_end: "2026-10-09" }),
      route({ origin: "SLC", destination: "PIT", date_start: "2027-03-05", date_end: "2027-03-07" }),
    ]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "SLC", "PIT", "2027-03-07")).toBe(true);
    // Each route's airports, at the OTHER's dates.
    expect(admits(scope, "PIT", "BOS", "2027-03-07")).toBe(false);
    expect(admits(scope, "SLC", "PIT", "2026-10-08")).toBe(false);
    // And a pair spliced out of one route's origins and the other's destinations.
    expect(admits(scope, "SLC", "BOS", "2026-10-08")).toBe(false);
  });
});

describe("routeFindsScope — the JSON columns", () => {
  it("falls back to the scalar when a list column is absent", () => {
    const scope = routeFindsScope([route()]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "SEA", "BOS", "2026-10-08")).toBe(false);
  });

  it("falls back to the scalar on an EMPTY list, matching the matcher", () => {
    // `codeSet` reads an empty array as the scalar too, so the route still
    // covers PIT. A superset is the contract either way.
    const scope = routeFindsScope([route({ origins: "[]" })]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
  });

  it("falls back to the scalar on malformed JSON rather than throwing", () => {
    const scope = routeFindsScope([route({ origins: "{not json" })]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
  });

  it("adds nothing for an empty via", () => {
    const scope = routeFindsScope([route({ via: "[]" })]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "PIT", "DTW", "2026-10-08")).toBe(false);
  });

  it("dedupes an airport that is both an origin and a hub", () => {
    // Two origins (PIT, DTW), not three. Binds are the budget that decides
    // whether the per-route form is used at all.
    const scope = routeFindsScope([route({ via: '["PIT","DTW"]' })]);
    expect(scope.where[0]).toContain("origin IN (?, ?)");
  });
});

/**
 * The read filters, pushed down.
 *
 * These were applied only in JS until the collapse that forbade them was
 * removed, and the cost was the whole gap between what the page reads and what
 * it shows: 14,216 rows read to display 842, measured on production, most of it
 * one year-long hub route whose points ceiling nothing in SQL knew about.
 *
 * Each `it` below is a pair: the scope must EXCLUDE what the matcher rejects
 * (that is the saving) and must ADMIT what it accepts (that is the contract).
 * Only the second direction can lose data, which is why `matches the matcher on
 * every combination` exists underneath them.
 */
describe("routeFindsScope — the read filters", () => {
  it("pushes the cabin filter", () => {
    const scope = routeFindsScope([route({ cabins: '["business","first"]' })]);
    expect(admitted(scope, [find({ cabin: "business" })])).toHaveLength(1);
    expect(admitted(scope, [find({ cabin: "economy" })])).toHaveLength(0);
  });

  it("pushes min_seats", () => {
    const scope = routeFindsScope([route({ min_seats: 2 })]);
    expect(admitted(scope, [find({ seats_available: 2 })])).toHaveLength(1);
    expect(admitted(scope, [find({ seats_available: 1 })])).toHaveLength(0);
  });

  it("pushes direct_only", () => {
    const scope = routeFindsScope([route({ direct_only: 1 })]);
    expect(admitted(scope, [find({ is_direct: 1 })])).toHaveLength(1);
    expect(admitted(scope, [find({ is_direct: 0 })])).toHaveLength(0);
  });

  it("pushes point_limit, inclusively", () => {
    const scope = routeFindsScope([route({ point_limit: 100_000 })]);
    expect(admitted(scope, [find({ miles_cost: 100_000 })])).toHaveLength(1);
    expect(admitted(scope, [find({ miles_cost: 100_001 })])).toHaveLength(0);
  });

  it("does NOT push currencies", () => {
    // Deliberate, and the reason is `routeMatch.ts`'s: it reads a malformed
    // filter column as "no filter" because blanking the Routes page over one bad
    // column is worse than showing an unfiltered row. `json_each` on malformed
    // JSON raises and fails the whole request instead. The matcher still applies
    // this in JS — the scope just reads the row first.
    // `RouteFilters` does not carry `currencies` at all, so there is nothing to
    // push even by accident — this pins that the SQL never grows one.
    const scope = routeFindsScope([route({ cabins: '["business"]' })]);
    expect(scope.where[0]).not.toContain("transfer_currencies");
    expect(scope.where[0]).not.toContain("json_each");
    expect(admitted(scope, [find({ transfer_currencies: '["amex_mr"]' })])).toHaveLength(1);
  });

  it("omits a filter it cannot read, rather than guessing", () => {
    // Omission widens, which is safe. Guessing narrows, which is not.
    for (const cabins of ["{not json", '"business"', "[]"]) {
      const scope = routeFindsScope([route({ cabins })]);
      expect(admitted(scope, [find({ cabin: "economy" })])).toHaveLength(1);
    }
  });

  it("keeps each route's filters to its own OR-group", () => {
    // The failure this prevents: a nonstop-only PIT->BOS route's `is_direct = 1`
    // leaking across the OR and hiding every connection on a PIT->HND hub route
    // that wants them.
    const scope = routeFindsScope([
      route({ direct_only: 1 }),
      route({ origin: "PIT", destination: "HND", direct_only: 0 }),
    ]);
    expect(admitted(scope, [find({ destination: "BOS", is_direct: 0 })])).toHaveLength(0);
    expect(admitted(scope, [find({ destination: "HND", is_direct: 0 })])).toHaveLength(1);
  });

  it("matches the matcher on every combination", () => {
    // The superset property itself, run rather than argued. Both engines see the
    // same rows: `routeMatcher` in JS, and the scope's SQL in SQLite. The scope
    // may keep a row the matcher rejects — that only costs a read — but a row
    // the matcher accepts and the scope drops is invisible data loss, and is
    // what this fails on.
    const routes: FilteredRoute[] = [
      route({ cabins: '["business","first"]', min_seats: 2, point_limit: 100_000 }),
      route({ origin: "PIT", destination: "HND", via: '["DTW"]', date_end: "2026-10-20" }),
      route({ origin: "SLC", destination: "PIT", round_trip: 1, direct_only: 1 }),
    ];
    const rows: Row[] = [];
    for (const [origin, destination] of [
      ["PIT", "BOS"],
      ["BOS", "PIT"],
      ["PIT", "HND"],
      ["PIT", "DTW"],
      ["DTW", "HND"],
      ["SLC", "PIT"],
      ["PIT", "SLC"],
      ["SEA", "NRT"],
    ]) {
      for (const flight_date of ["2026-10-07", "2026-10-08", "2026-10-20", "2026-10-21"]) {
        for (const cabin of ["economy", "business"]) {
          for (const seats_available of [1, 4]) {
            for (const miles_cost of [50_000, 150_000]) {
              for (const is_direct of [0, 1]) {
                rows.push(
                  find({ origin, destination, flight_date, cabin, seats_available, miles_cost, is_direct }),
                );
              }
            }
          }
        }
      }
    }

    const scope = routeFindsScope(routes);
    const kept = admitted(scope, rows);
    const key = (r: Row) =>
      [r.origin, r.destination, r.flight_date, r.cabin, r.seats_available, r.miles_cost, r.is_direct].join("|");
    const keptKeys = new Set(kept.map(key));

    // `RouteFilters` is optional where `MatchableRoute` is not, and each default
    // here is the matcher's own reading of an absent column. `currencies` is
    // null because the scope never receives it — see the test above.
    const matchable = (r: FilteredRoute): MatchableRoute => ({
      ...r,
      cabins: r.cabins ?? null,
      currencies: null,
      direct_only: r.direct_only ?? 0,
      point_limit: r.point_limit ?? null,
      min_seats: r.min_seats ?? 1,
    });
    const matchers = routes.map((r) => routeMatcher(matchable(r)));
    const wanted = rows.filter((r) => matchers.some((m) => m.matches(r)));

    // Non-trivial on both sides: a scope that admitted everything would pass the
    // superset check and be worth nothing.
    expect(wanted.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(rows.length);
    for (const r of wanted) expect(keptKeys.has(key(r))).toBe(true);
  });
});

describe("routeFindsScope — the bind budget", () => {
  it("keeps binds in the order the ? placeholders appear", () => {
    const scope = routeFindsScope([
      route({
        origins: '["SEA","PDX"]',
        destinations: '["NRT","HND"]',
        cabins: '["business"]',
        min_seats: 2,
        point_limit: 100_000,
      }),
    ]);
    // `findsFrom` interpolates where.join(" AND ") and spreads these binds in
    // order, so a mismatch here filters on the wrong values silently — and it
    // would not throw, because a cabin code and an airport code are both TEXT.
    expect(scope.binds).toEqual([
      "SEA",
      "PDX",
      "NRT",
      "HND",
      "2026-10-08",
      "2026-10-10",
      "business",
      2,
      100_000,
    ]);
    expect(scope.where).toEqual([
      "((origin IN (?, ?) AND destination IN (?, ?) AND flight_date BETWEEN ? AND ?" +
        " AND cabin IN (?) AND seats_available >= ? AND miles_cost <= ?))",
    ]);
  });

  it("stays inside D1's 100-bind limit at the widest route the wire contract allows", () => {
    // MAX_ORIGINS / MAX_DESTINATIONS / MAX_VIA are three apiece, and a round
    // trip cross-pollinates both sides. This is the shape that ruled out the
    // route_key-range form, whose pair set is O(n^2): 36 pairs, 144 binds.
    const scope = routeFindsScope([
      route({
        origins: '["SEA","PDX","BFI"]',
        destinations: '["NRT","HND","KIX"]',
        via: '["ICN","TPE","HKG"]',
        round_trip: 1,
        cabins: '["economy","premium","business","first"]',
        min_seats: 2,
        point_limit: 100_000,
      }),
    ]);
    // Consumed once by findsFrom, plus the caller's own.
    expect(scope.binds.length + 1).toBeLessThanOrEqual(100);
    expect(scope.where).toHaveLength(1);
  });

  it("drops to the UNION form when the per-route one runs out of binds", () => {
    // The middle rung. Correct, and as wide as what shipped before — the point
    // is that it is reached instead of UNSCOPED, which reads the whole table.
    const many = Array.from({ length: 25 }, (_, i) =>
      route({ origin: `O${i}`, destination: `D${i}` }),
    );
    const scope = routeFindsScope(many);
    expect(scope.where).toHaveLength(3);
    expect(admits(scope, "O3", "D3", "2026-10-08")).toBe(true);
    // The union's cross product, which is exactly what it costs.
    expect(admits(scope, "O3", "D7", "2026-10-08")).toBe(true);
  });

  it("falls back to UNSCOPED rather than emitting a statement D1 would refuse", () => {
    // Slow and right beats fast and refused. Far more routes than the UI makes
    // easy, but the failure mode is a runtime error, not a slow query.
    const many = Array.from({ length: 60 }, (_, i) =>
      route({ origin: `O${i}`, destination: `D${i}` }),
    );
    const scope = routeFindsScope(many);
    expect(scope.where).toEqual([]);
    expect(scope.binds).toEqual([]);
    expect(admits(scope, "anything", "at-all", "2099-01-01")).toBe(true);
  });

  it("is UNSCOPED for an empty route set", () => {
    // No routes means the Routes page has nothing to join against anyway, and
    // `origin IN ()` is a syntax error.
    expect(routeFindsScope([])).toEqual({ where: [], binds: [] });
  });
});


/**
 * The authorization question behind `POST /api/finds/enrich`.
 *
 * That endpoint is the only one that names an availability row by its
 * COORDINATES rather than by a route id, and then spends a metered seats.aero
 * call on it and writes back. It used to accept any (origin, destination, date,
 * program) in the database — the cheapest way to drain the day's Partner-API
 * quota, which in turn silently disables the alert sweep for the rest of the
 * UTC day.
 *
 * `withinRouteScope` shares `scopeSets` with `routeFindsScope` on purpose, so
 * the check and the read path cannot drift. These pin BOTH directions: that it
 * refuses what no route asked about, and — the failure mode that would actually
 * get noticed — that it still permits the hub legs and round-trip reversals the
 * Routes page legitimately shows.
 */
describe("withinRouteScope", () => {
  const route = (over: Partial<ScopedRoute> = {}): ScopedRoute => ({
    origin: "SFO",
    destination: "NRT",
    origins: null,
    destinations: null,
    via: null,
    date_start: "2026-09-01",
    date_end: "2026-09-30",
    round_trip: 0,
    ...over,
  });

  it("permits a find the route plainly covers", () => {
    expect(withinRouteScope([route()], "SFO", "NRT", "2026-09-15")).toBe(true);
  });

  it("refuses a pair no route asked about", () => {
    expect(withinRouteScope([route()], "JFK", "LHR", "2026-09-15")).toBe(false);
    expect(withinRouteScope([route()], "SFO", "LHR", "2026-09-15")).toBe(false);
  });

  it("refuses a date outside every route's window", () => {
    expect(withinRouteScope([route()], "SFO", "NRT", "2026-08-31")).toBe(false);
    // The read path widens `hi` by a day for the overnight-in-hub case, so this
    // must agree rather than being a day stricter.
    expect(withinRouteScope([route()], "SFO", "NRT", "2026-10-01")).toBe(true);
    expect(withinRouteScope([route()], "SFO", "NRT", "2026-10-02")).toBe(false);
  });

  it("permits both legs of a hub route", () => {
    const hub = [route({ via: JSON.stringify(["HND"]) })];
    expect(withinRouteScope(hub, "SFO", "HND", "2026-09-15")).toBe(true);
    expect(withinRouteScope(hub, "HND", "NRT", "2026-09-15")).toBe(true);
  });

  it("permits the reversal on a round trip, and not otherwise", () => {
    expect(withinRouteScope([route({ round_trip: 1 })], "NRT", "SFO", "2026-09-15")).toBe(true);
    expect(withinRouteScope([route()], "NRT", "SFO", "2026-09-15")).toBe(false);
  });

  it("reads the multi-airport lists, not just the scalars", () => {
    const wide = [route({ origins: JSON.stringify(["SFO", "OAK"]) })];
    expect(withinRouteScope(wide, "OAK", "NRT", "2026-09-15")).toBe(true);
  });

  it("permits NOTHING when there are no routes", () => {
    // The direction that matters: `routeFindsScope` answers the same degenerate
    // input with UNSCOPED — "read everything" — and an authorization check that
    // borrowed that answer would permit everything.
    expect(withinRouteScope([], "SFO", "NRT", "2026-09-15")).toBe(false);
  });
});

describe("findsFrom — the best-ever seek", () => {
  const scope = routeFindsScope([
    {
      origin: "SEA",
      destination: "NRT",
      origins: null,
      destinations: null,
      via: null,
      date_start: "2026-10-08",
      date_end: "2026-10-10",
      round_trip: 0,
    },
  ]);

  it("adds no bind, so every caller's .bind() line is unchanged", () => {
    // The scope's binds are consumed exactly once, and a correlated subquery
    // that took a bind of its own would land among them and shift every
    // placeholder after it. Callers append their own binds after these.
    expect(findsFrom(scope).binds).toEqual(scope.binds);
  });

  it("reads one bare table, with no join and no subquery", () => {
    // There is one row per slot, so a find IS a row. Every join and correlated
    // subquery this used to carry existed to collapse history that no longer
    // exists, and each was measured in tens of thousands of rows read.
    const { sql } = findsFrom(scope);
    expect(sql).toContain("FROM finds f");
    for (const forbidden of ["JOIN", "SELECT", "GROUP BY"]) expect(sql).not.toContain(forbidden);
  });
});
