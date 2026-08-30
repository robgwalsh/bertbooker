import { describe, expect, it } from "vitest";
import type { FindsScope, ScopedRoute } from "./finds.js";
import { BEST_MILES_EVER, FIND_COLUMNS, findsFrom, routeFindsScope, withinRouteScope } from "./finds.js";

/**
 * The scope is the one part of the read path that can lose data silently.
 *
 * `findsFrom` used to collapse every snapshot in the database to answer about
 * one route — 171,471 rows read for a route whose entire input was 23. Narrowing
 * that is where nearly all of this app's D1 bill went, and the narrowing is only
 * safe while it stays a **superset** of everything `ROUTE_FINDS_MATCH` accepts.
 * A branch added there without a matching widening in `routeFindsScope` drops
 * finds out of the Routes page and out of alert digests — and a digest that finds
 * nothing sends no mail, so nothing would report it.
 *
 * So these tests are witnesses, one per branch of `ROUTE_FINDS_MATCH`, checked
 * against the scope's own binds. They deliberately do NOT re-implement the match
 * rule in TypeScript: a second copy of it is exactly what `ROUTE_FINDS_MATCH`'s
 * docblock exists to prevent, and it would agree with itself while both drifted
 * from the SQL.
 */

const route = (o: Partial<ScopedRoute> = {}): ScopedRoute => ({
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

/** Read a scope's binds back the way the SQL does. The `where` shape is fixed —
 *  `origin IN (…)`, `destination IN (…)`, `flight_date BETWEEN ? AND ?` — so the
 *  binds split by the placeholder counts in that text. Parsing it rather than
 *  trusting a remembered layout is what makes `keeps binds in ? order` real. */
function read(scope: FindsScope) {
  const counts = scope.where.map((w) => (w.match(/\?/g) ?? []).length);
  const [nOrigins = 0, nDests = 0] = counts;
  return {
    origins: new Set(scope.binds.slice(0, nOrigins) as string[]),
    destinations: new Set(scope.binds.slice(nOrigins, nOrigins + nDests) as string[]),
    lo: scope.binds[nOrigins + nDests] as string,
    hi: scope.binds[nOrigins + nDests + 1] as string,
  };
}

/** Would this find survive the scope? The scope admits a find when its airports
 *  are in the two sets and its date is in the window — which is all the SQL
 *  asks. */
function admits(scope: FindsScope, origin: string, destination: string, date: string): boolean {
  if (!scope.where.length) return true; // unscoped admits everything, by definition
  const { origins, destinations, lo, hi } = read(scope);
  return origins.has(origin) && destinations.has(destination) && date >= lo && date <= hi;
}

describe("routeFindsScope — the superset property, one witness per branch", () => {
  it("admits the forward branch", () => {
    const scope = routeFindsScope([route()]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "PIT", "BOS", "2026-10-09")).toBe(true);
  });

  it("admits every pair of a multi-airport route", () => {
    // MEMBERSHIP, not equality — the same rule ROUTE_FINDS_MATCH's json_each
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
    // ROUTE_FINDS_MATCH widens exactly this branch by a day. The scope widens
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

  it("unions across routes, taking the widest window", () => {
    const scope = routeFindsScope([
      route({ date_start: "2026-10-08", date_end: "2026-10-09" }),
      route({ origin: "SLC", destination: "PIT", date_start: "2027-03-05", date_end: "2027-03-07" }),
    ]);
    expect(admits(scope, "PIT", "BOS", "2026-10-08")).toBe(true);
    expect(admits(scope, "SLC", "PIT", "2027-03-07")).toBe(true);
    const { lo, hi } = read(scope);
    expect(lo).toBe("2026-10-08");
    expect(hi).toBe("2027-03-08");
  });
});

describe("routeFindsScope — the JSON columns", () => {
  it("falls back to the scalar when a list column is absent", () => {
    const { origins, destinations } = read(routeFindsScope([route()]));
    expect([...origins]).toEqual(["PIT"]);
    expect([...destinations]).toEqual(["BOS"]);
  });

  it("falls back to the scalar on an EMPTY list, matching the SQL", () => {
    // json_each('[]') yields nothing, so the SQL branch would match nothing.
    // The scalar is still a superset of that, and a superset is the contract.
    const { origins } = read(routeFindsScope([route({ origins: "[]" })]));
    expect([...origins]).toEqual(["PIT"]);
  });

  it("falls back to the scalar on malformed JSON rather than throwing", () => {
    const { origins } = read(routeFindsScope([route({ origins: "{not json" })]));
    expect([...origins]).toEqual(["PIT"]);
  });

  it("adds nothing for an empty via, which is non-NULL and enters the SQL branch", () => {
    const { origins, destinations } = read(routeFindsScope([route({ via: "[]" })]));
    expect([...origins]).toEqual(["PIT"]);
    expect([...destinations]).toEqual(["BOS"]);
  });

  it("dedupes an airport that is both an origin and a hub", () => {
    const scope = routeFindsScope([route({ via: '["PIT","DTW"]' })]);
    const { origins } = read(scope);
    expect([...origins].filter((x) => x === "PIT")).toHaveLength(1);
  });
});

describe("routeFindsScope — the bind budget", () => {
  it("keeps binds in the order the ? placeholders appear", () => {
    const scope = routeFindsScope([
      route({ origins: '["SEA","PDX"]', destinations: '["NRT","HND"]' }),
    ]);
    // `findsFrom` interpolates where.join(" AND ") and spreads these binds in
    // order, so a mismatch here filters on the wrong values silently.
    expect(scope.binds).toEqual(["SEA", "PDX", "NRT", "HND", "2026-10-08", "2026-10-10"]);
    expect(scope.where.join(" AND ")).toBe(
      "origin IN (?, ?) AND destination IN (?, ?) AND flight_date BETWEEN ? AND ?",
    );
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
      }),
    ]);
    // Consumed once by findsFrom, plus the caller's own.
    expect(scope.binds.length + 1).toBeLessThanOrEqual(100);
    expect(scope.where.length).toBe(3);
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

  it("correlates best_miles_ever on the whole slot key", () => {
    // It is computed rather than stored, so it is not in FIND_COLUMNS — a caller
    // that wants it appends this expression.
    expect(FIND_COLUMNS).not.toContain("best_miles_ever");
    expect(BEST_MILES_EVER).toContain("MIN(ph.miles_cost)");
    // All three ARE the slot key, and the table holds one row per slot, so the
    // seek returns exactly one row per find.
    for (const col of ["ph.route_key = f.route_key", "ph.program = f.program", "ph.cabin = f.cabin"])
      expect(BEST_MILES_EVER).toContain(col);
    // Load-bearing: idx_ph_best is PARTIAL, and SQLite only uses a partial index
    // when the query WHERE implies the index WHERE. Without this the seek falls
    // to idx_ph_slot and costs a row fetch each.
    expect(BEST_MILES_EVER).toContain("ph.miles_cost IS NOT NULL");
  });
});
