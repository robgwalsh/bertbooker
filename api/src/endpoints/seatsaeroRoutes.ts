import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type {
  GraphPath,
  PairCoverage,
  PairPaths,
  PairProgram,
  PathSearchResult,
  RouteFetchResult,
  RouteGraphEdge,
  RouteGraphGeo,
  RouteGraphRow,
  RouteGraphSource,
  ReachReport,
} from "../../../shared/src/wire/index.js";
import {
  SEATSAERO_SOURCE_CATALOGUE,
  SEATSAERO_ZERO_ROUTE_NAMES,
  runSeatsAeroRoutes,
} from "../providers/seatsaero.js";
import { searchPairs } from "../domain/routing.js";
import { classifyError, clientMessage, makeTransport } from "../providers/transport.js";
import { PROGRAM_SEEDS, currenciesForProgram } from "../domain/programs.js";
import { assessGraphReach, type ReachRouteInput } from "../domain/graphReach.js";
import {
  ROUTE_HARD_MAX,
  fetchedSources,
  graphRowsForPairs,
  readFetchRecords,
  recordRouteFetch,
  replaceSourceRoutes,
} from "../db/routeGraph.js";
import { recordQuota } from "../db/runs.js";
import {
  REACH_DEEP_PAIRS,
  pairKeyOf,
  programOf,
  searchGraphPaths,
} from "../search/graphPaths.js";

/**
 * The Library's seats.aero pane: the route graph each program's award inventory
 * is monitored on (`docs/SEATS-AERO.md` §12).
 *
 * ROUTE ORDER IS LOAD-BEARING within this file, the same way it is in
 * `airports.ts`: `/routes/geo` and `/routes/pair` are registered before the bare
 * `/api/seatsaero/routes`, because Hono runs matching handlers in registration
 * order and stops at the first that responds.
 *
 * **Exactly one path here spends money** — `POST .../fetch`, one metered call.
 * Everything else is a D1 read of what that call already bought, which is the
 * whole reason the graph is cached rather than proxied: browsing 26 programs
 * live would be 26 calls every time the pane was opened.
 *
 * Nothing here is gated on `isLocalRequest`. `/api/airports/geo` is, because the
 * Airports pane is dev-only; this pane ships, which is also why the map takes
 * its coordinates from the join below rather than calling that endpoint.
 */
export const seatsaeroRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const PROGRAM_BY_CODE = new Map(PROGRAM_SEEDS.map((s) => [s.code, s]));
const KNOWN_EMPTY = new Set(SEATSAERO_ZERO_ROUTE_NAMES);

function describeSource(source: string): Omit<RouteGraphSource, "fetch"> {
  const program = programOf(source);
  const seed = program ? PROGRAM_BY_CODE.get(program) : undefined;
  return {
    source,
    program,
    label: seed?.name ?? source,
    alliance: seed?.alliance ?? null,
    currencies: program ? currenciesForProgram(program) : [],
    knownEmpty: KNOWN_EMPTY.has(source),
  };
}

// ---- The catalogue, and what each source last said -------------------------
seatsaeroRoutes.get("/api/seatsaero/sources", async (c) => {
  const records = await readFetchRecords(c.env.DB);
  const bySource = new Map(records.map((r) => [r.source, r]));
  // The catalogue plus the known-empty names, so the pane can DEMONSTRATE what
  // `empty` means rather than asking the operator to invent a wrong name.
  const all = [...SEATSAERO_SOURCE_CATALOGUE, ...SEATSAERO_ZERO_ROUTE_NAMES];
  const body: RouteGraphSource[] = all.map((source) => ({
    ...describeSource(source),
    fetch: bySource.get(source) ?? null,
  }));
  return c.json(body);
});

// ---- THE ONE METERED PATH --------------------------------------------------
//
// Everything fallible happens before anything is written: a missing key is a
// 503 and a refused call is a 502, never a stored graph of zero routes. That
// ordering is what keeps `empty` meaning "seats.aero does not know this name"
// instead of "something went wrong once".
seatsaeroRoutes.post("/api/seatsaero/sources/:source/fetch", async (c) => {
  const source = c.req.param("source").trim().toLowerCase();
  if (!source) return c.json({ error: "bad_request" }, 400);

  // A free-typed name is allowed on purpose: testing whether seats.aero knows a
  // name is the point of the surface, and refusing unknown ones would refuse
  // exactly the experiment. The catalogue is what the UI offers, not a wall.
  if (!/^[a-z0-9_-]{2,32}$/.test(source)) return c.json({ error: "unknown_source" }, 400);

  const apiKey = c.env.SEATS_AERO_API_KEY;
  if (!apiKey) return c.json({ error: "no_seats_aero_key" }, 503);

  const fetchedAt = Date.now();
  let result: Awaited<ReturnType<typeof runSeatsAeroRoutes>>;
  try {
    result = await runSeatsAeroRoutes(source, { apiKey, transport: makeTransport({}) });
  } catch (err) {
    // Read the allowance even off a failure — a 429 is exactly when it matters.
    const quota = (err as { quota?: Parameters<typeof recordQuota>[1][number] }).quota;
    if (quota) await recordQuota(c.env.DB, [quota]);
    const { status, message } = classifyError(err);
    // The graph already stored for this source is left exactly where it is: a
    // refused call is not evidence about a program's network.
    await recordRouteFetch(c.env.DB, source, {
      status: "failed",
      routeCount: 0,
      duplicates: 0,
      malformed: 0,
      fetchedAt,
      httpStatus: (err as { httpStatus?: number }).httpStatus ?? null,
      error: `${status}: ${message}`,
    });
    // Recorded above with the raw message, returned here without it — the same
    // split the search stream makes. The recorded row is the fetch's own history
    // and is worth keeping precise; this is the immediate reply to a button press.
    return c.json(
      { error: "routes_fetch_failed", message: `${status}: ${clientMessage(err)}` },
      502,
    );
  }

  if (result.quota) await recordQuota(c.env.DB, [result.quota]);

  if (result.routes.length > ROUTE_HARD_MAX) {
    await recordRouteFetch(c.env.DB, source, {
      status: "failed",
      routeCount: 0,
      duplicates: result.duplicates,
      malformed: result.malformed,
      fetchedAt,
      httpStatus: result.httpStatus,
      bytes: result.bytes,
      error: `too_many_rows: ${result.routes.length}`,
    });
    return c.json(
      { error: "routes_fetch_failed", message: `too many rows: ${result.routes.length}` },
      502,
    );
  }

  await replaceSourceRoutes(c.env.DB, source, result.routes, {
    // `empty` is a SUCCESSFUL call that returned nothing — the answer that says
    // seats.aero does not recognise this source name. Never `failed`.
    status: result.routes.length ? "ok" : "empty",
    routeCount: result.routes.length,
    duplicates: result.duplicates,
    malformed: result.malformed,
    fetchedAt,
    durationMs: result.durationMs,
    httpStatus: result.httpStatus,
    bytes: result.bytes,
  });

  const records = await readFetchRecords(c.env.DB);
  const record = records.find((r) => r.source === source);
  if (!record) return c.json({ error: "not_found" }, 404);
  const body: RouteFetchResult = {
    record,
    quotaRemaining: result.quota?.remaining ?? null,
  };
  return c.json(body);
});

// Shared WHERE builder for the graph table and the graph map — the pair that
// must never disagree about which set is on screen. Anonymous `?` binds pushed
// in SQL order, so callers append their own (ORDER BY, LIMIT) only AFTER these.
//
// `source` is REQUIRED here, unlike `airportFilter`'s "no query -> major
// airports" default. A route graph is per-program by nature, and the
// cross-source question has its own surface at `/routes/pair`.
export function routeFilter(query: (k: string) => string | undefined): {
  source: string;
  where: string[];
  binds: unknown[];
} {
  const source = (query("source") ?? "").trim().toLowerCase();
  const where: string[] = ["r.source = ?"];
  const binds: unknown[] = [source];

  const eq = (param: string, column: string) => {
    const v = (query(param) ?? "").trim().toUpperCase();
    if (!v) return;
    where.push(`r.${column} = ?`);
    binds.push(v);
  };
  eq("origin", "origin");
  eq("destination", "destination");

  const region = (param: string, column: string) => {
    const v = (query(param) ?? "").trim();
    if (!v) return;
    where.push(`r.${column} = ?`);
    binds.push(v);
  };
  region("originRegion", "origin_region");
  region("destinationRegion", "destination_region");

  const range = (param: string, op: string) => {
    const raw = query(param);
    if (raw === undefined || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    where.push(`r.distance_mi ${op} ?`);
    binds.push(n);
  };
  range("minDistance", ">=");
  range("maxDistance", "<=");

  const q = (query("q") ?? "").trim();
  if (q) {
    // One token, matched against either end of the pair. Deliberately simpler
    // than `airportFilter`'s multi-token AND: a route row is a pair, and
    // "SFO tokyo" would mean something this table cannot answer.
    if (/^[A-Za-z]{3}$/.test(q)) {
      // THREE LETTERS IS A CODE, and only a code.
      //
      // Substring-matching a three-letter token against airport names is close
      // to useless: "PIT" appears in "Aspen-Pitkin County", in "Beijing
      // CaPITal" and in "Cherry CaPITal", so asking for Pittsburgh returned
      // Aspen, Beijing and Traverse City. Short tokens are overwhelmingly codes
      // — the default-airport preference produces nothing else — so they are
      // treated as one, and anything longer keeps the name search below.
      const code = q.toUpperCase();
      where.push("(r.origin = ? OR r.destination = ?)");
      binds.push(code, code);
    } else {
      // `%` and `_` are LIKE metacharacters and `q` is whatever was typed. The
      // value is BOUND, so this was never injectable — but an unescaped pattern
      // is still a pattern the caller gets to write, and `%a%b%c%d%e%…` against
      // the joined seatsaero_routes × airports set makes both the COUNT(*) and
      // the row read below scan repeatedly. D1 bills rows read.
      const contains = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push(
        `(ao.name LIKE ? ESCAPE '\\' OR ad.name LIKE ? ESCAPE '\\'
          OR ao.city LIKE ? ESCAPE '\\' OR ad.city LIKE ? ESCAPE '\\')`,
      );
      binds.push(contains, contains, contains, contains);
    }
  }

  return { source, where, binds };
}

/**
 * Join `airports` by IATA code, one row per code.
 *
 * This used to be `(SELECT … FROM airports WHERE iata != '' GROUP BY iata)`,
 * inlined at each use, guarding against duplicate codes multiplying a pair into
 * several edges. The guard cost more than the thing it guarded against: SQLite
 * MATERIALIZEs that subquery per use — twice per route query and FOUR times per
 * `/routes/geo` request, since the shared `from` fragment is used by the count
 * and the rows — and each materialization walks all 72,454 entries of
 * `idx_airports_iata`. It measured 34,574 rows read to return 200.
 *
 * It was also guarding against nothing: the seed has **9,054 rows with an IATA
 * code and 9,054 distinct codes**. `scripts/build-airports.mjs` now refuses to
 * write a seed that would break that, so the invariant is enforced where the
 * data is made rather than re-derived in every query that reads it. A plain join
 * is then two `idx_airports_iata` seeks per row.
 */
const airportJoin = (alias: string, col: string) =>
  `LEFT JOIN airports ${alias} ON ${alias}.iata = ${col} AND ${alias}.iata != ''`;

// ---- Slim rows + coordinates for the map -----------------------------------
seatsaeroRoutes.get("/api/seatsaero/routes/geo", async (c) => {
  const { source, where, binds } = routeFilter((k) => c.req.query(k));
  if (!source) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20000, 1), 50000);

  const from = `FROM seatsaero_routes r
                ${airportJoin("ao", "r.origin")}
                ${airportJoin("ad", "r.destination")}
                WHERE ${where.join(" AND ")}`;

  const counted = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${from}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = counted?.n ?? 0;

  const { results } = await c.env.DB.prepare(
    `SELECT r.origin, r.destination,
            ao.latitude AS origin_lat, ao.longitude AS origin_lon,
            ad.latitude AS destination_lat, ad.longitude AS destination_lon
     ${from} LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<RouteGraphEdge>();

  const body: RouteGraphGeo = { edges: results, total, truncated: total > results.length };
  return c.json(body);
});

// ---- Who flies this pair? --------------------------------------------------
// An exact lookup across every source, deliberately NOT routed through
// `routeFilter` — that builder is a source-scoped search, and this is the one
// question that is not about a single program.
seatsaeroRoutes.get("/api/seatsaero/routes/pair", async (c) => {
  const origin = (c.req.query("origin") ?? "").trim().toUpperCase();
  const destination = (c.req.query("destination") ?? "").trim().toUpperCase();
  if (!origin || !destination) return c.json({ error: "bad_request" }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT source, origin, destination, distance_mi
       FROM seatsaero_routes
      WHERE (origin = ?1 AND destination = ?2)
         OR (origin = ?2 AND destination = ?1)`,
  )
    .bind(origin, destination)
    .all<{ source: string; origin: string; destination: string; distance_mi: number | null }>();

  const records = await readFetchRecords(c.env.DB);
  const fetched = new Set(fetchedSources(records));

  const toProgram = (r: (typeof results)[number]): PairProgram => {
    const d = describeSource(r.source);
    return {
      source: r.source,
      program: d.program,
      label: d.label,
      currencies: d.currencies,
      distance_mi: r.distance_mi,
    };
  };
  const byLabel = (a: PairProgram, b: PairProgram) => a.label.localeCompare(b.label);
  // A source whose last fetch failed still has rows from an earlier one; they
  // are not authoritative, so they are left out rather than quietly counted.
  const live = results.filter((r) => fetched.has(r.source));

  const body: PairCoverage = {
    origin,
    destination,
    forward: live.filter((r) => r.origin === origin).map(toProgram).sort(byLabel),
    reverse: live.filter((r) => r.origin === destination).map(toProgram).sort(byLabel),
    fetchedSources: [...fetched],
  };
  return c.json(body);
});

// ---- Getting there with a stop ---------------------------------------------
//
// The escalation ladder, shared by the pair lookup below and the reach sweep
// after it: two callers and one behaviour, which is the same reason
// `search/run.ts` is split from its HTTP shell.
//
// **It stops at the first depth that answers.** JFK->LHR is a monitored market
// and never runs a self-join at all; SFO->KTM answers at one stop through seven
// hubs; PIT->KTM has no one-stop option and needs two. Going deeper than the
// shallowest answer would bury the good routing under hundreds of worse ones.

// ---- How would I get there? ------------------------------------------------
// Registered BEFORE the bare `/api/seatsaero/routes`, like its two siblings
// above. Pure D1 reads, so it spends nothing — the graph it walks was already
// bought by the one metered path at the top of this file.
seatsaeroRoutes.get("/api/seatsaero/routes/paths", async (c) => {
  const origin = (c.req.query("origin") ?? "").trim().toUpperCase();
  const destination = (c.req.query("destination") ?? "").trim().toUpperCase();
  if (!origin || !destination || origin === destination) {
    return c.json({ error: "bad_request" }, 400);
  }

  const records = await readFetchRecords(c.env.DB);
  const fetched = new Set(fetchedSources(records));

  // Direct first, and a monitored market ends the search: the pane already lists
  // who flies it, and a connection is an answer to a question nobody asked.
  const directRows = await graphRowsForPairs(c.env.DB, [
    { origin, destination },
    { origin: destination, destination: origin },
  ]);
  const flownDirect = new Set(
    directRows
      .filter((r) => fetched.has(r.source))
      .map((r) => pairKeyOf(r.origin, r.destination)),
  );

  const wanted = [
    { origin, destination },
    { origin: destination, destination: origin },
  ].filter((p) => !flownDirect.has(pairKeyOf(p.origin, p.destination)));

  const { results } = await searchGraphPaths(c.env.DB, wanted, { fetched, maxStops: 2 });

  const direction = (from: string, to: string): PathSearchResult =>
    flownDirect.has(pairKeyOf(from, to))
      ? { depth: 0, paths: [], truncated: false }
      : (results.get(pairKeyOf(from, to)) ?? { depth: 2, paths: [], truncated: false });

  const body: PairPaths = {
    origin,
    destination,
    forward: direction(origin, destination),
    reverse: direction(destination, origin),
    fetchedSources: [...fetched],
  };
  return c.json(body);
});

// ---- Do the routes you track go anywhere anyone watches? -------------------
seatsaeroRoutes.get("/api/seatsaero/reach", async (c) => {
  const email = c.get("userEmail");
  const { results: routes } = await c.env.DB.prepare(
    `SELECT id, origin, destination, origins, destinations, round_trip, programs
       FROM tracked_routes
      WHERE user_email = ? AND kind = 'flight'
      ORDER BY id`,
  )
    .bind(email)
    .all<{
      id: number;
      origin: string;
      destination: string;
      origins: string | null;
      destinations: string | null;
      round_trip: number;
      programs: string | null;
    }>();

  const parsed: ReachRouteInput[] = routes.map((r) => ({
    id: r.id,
    origin: r.origin,
    destination: r.destination,
    origins: parseCodes(r.origins),
    destinations: parseCodes(r.destinations),
    roundTrip: r.round_trip === 1,
    programs: parseCodes(r.programs),
  }));

  const records = await readFetchRecords(c.env.DB);
  const fetched = fetchedSources(records);

  // The union of every route's pairs, resolved once. `assessGraphReach` expands
  // each route again with the same function, which is cheap and keeps the pair
  // expansion in exactly one place.
  const pairs = new Map<string, { origin: string; destination: string }>();
  for (const route of parsed) {
    for (const p of expandForQuery(route)) pairs.set(`${p.origin}>${p.destination}`, p);
  }
  const graph = await graphRowsForPairs(c.env.DB, [...pairs.values()]);

  const base = {
    routes: parsed,
    graph,
    fetched,
    programOf,
    totalSources: SEATSAERO_SOURCE_CATALOGUE.length,
  };

  // ASSESSED TWICE, on purpose. The first pass is what says which pairs are
  // gaps; only those are worth a self-join, and only the function that owns the
  // gap rule should decide. Re-deriving gap-ness here would be a second copy of
  // that rule, drifting from the moment either changed. The pass is pure and
  // over a handful of routes, so the cost is nothing.
  const first = assessGraphReach(base);
  const gaps = new Map<string, { origin: string; destination: string }>();
  for (const route of first.routes) {
    for (const pair of route.pairs) {
      if (pair.verdict !== "gap") continue;
      gaps.set(pairKeyOf(pair.origin, pair.destination), {
        origin: pair.origin,
        destination: pair.destination,
      });
    }
  }

  const found = new Map<string, GraphPath[]>();
  let deepChecked = 0;
  let deepSkipped = new Set<string>();
  if (gaps.size) {
    const search = await searchGraphPaths(c.env.DB, [...gaps.values()], {
      fetched: new Set(fetched),
      maxStops: 2,
      deepPairLimit: REACH_DEEP_PAIRS,
    });
    for (const [key, result] of search.results) {
      if (result.paths.length) found.set(key, result.paths);
    }
    deepChecked = search.deepChecked;
    deepSkipped = search.deepSkipped;
  }

  const body: ReachReport = assessGraphReach({
    ...base,
    paths: found,
    deepSkipped,
    deepCheckedPairs: deepChecked,
    deepPairLimit: REACH_DEEP_PAIRS,
  });
  return c.json(body);
});

// ---- The table read (registered last — the bare path) ----------------------
seatsaeroRoutes.get("/api/seatsaero/routes", async (c) => {
  const { source, where, binds } = routeFilter((k) => c.req.query(k));
  if (!source) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);

  const { results } = await c.env.DB.prepare(
    `SELECT r.source, r.origin, r.destination, r.origin_region, r.destination_region,
            r.distance_mi,
            ao.name AS origin_name, ao.city AS origin_city,
            ad.name AS destination_name, ad.city AS destination_city
       FROM seatsaero_routes r
       ${airportJoin("ao", "r.origin")}
       ${airportJoin("ad", "r.destination")}
      WHERE ${where.join(" AND ")}
      ORDER BY r.origin, r.destination
      LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<RouteGraphRow>();
  return c.json(results);
});

function parseCodes(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v.map(String) : null;
  } catch {
    return null;
  }
}

/** The pairs to ASK the database about. Deliberately `searchPairs` — the same
 *  function `assessGraphReach` expands with and the same one the search plans
 *  with, so the query can never fetch a different pair set than the one the
 *  verdict is computed over. A spec the normalizer refuses contributes nothing
 *  rather than taking the panel down. */
function expandForQuery(route: ReachRouteInput): { origin: string; destination: string }[] {
  try {
    return searchPairs(
      {
        origins: route.origins?.length ? route.origins : [route.origin],
        destinations: route.destinations?.length ? route.destinations : [route.destination],
      },
      route.roundTrip,
    );
  } catch {
    return [];
  }
}
