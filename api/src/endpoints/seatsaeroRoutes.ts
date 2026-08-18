import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type {
  PairCoverage,
  PairProgram,
  RouteFetchResult,
  RouteGraphEdge,
  RouteGraphGeo,
  RouteGraphRow,
  RouteGraphSource,
  ReachReport,
} from "../../../shared/src/wire/index.js";
import {
  SEATSAERO_PROGRAM_MAP,
  SEATSAERO_SOURCE_CATALOGUE,
  SEATSAERO_ZERO_ROUTE_NAMES,
  runSeatsAeroRoutes,
} from "../providers/seatsaero.js";
import { searchPairs } from "../domain/routing.js";
import { classifyError, makeTransport } from "../providers/transport.js";
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

/** seats.aero source key -> our `programs.code`, or null when this app stores no
 *  program for it. `SEATSAERO_PROGRAM_MAP` stays the one owner of that mapping. */
const programOf = (source: string): string | null => SEATSAERO_PROGRAM_MAP[source] ?? null;

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
    return c.json({ error: "routes_fetch_failed", message: `${status}: ${message}` }, 502);
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
      const contains = `%${q}%`;
      where.push(
        `(ao.name LIKE ? OR ad.name LIKE ? OR ao.city LIKE ? OR ad.city LIKE ?)`,
      );
      binds.push(contains, contains, contains, contains);
    }
  }

  return { source, where, binds };
}

// `airports.iata` is NOT unique — several rows can carry the same code — so both
// joins pick one row per code rather than joining the table directly. A naive
// join would multiply a pair into as many edges as it has duplicate endpoints.
const AIRPORT_PICK = `(SELECT iata, name, city, latitude, longitude FROM airports
                        WHERE iata IS NOT NULL AND iata != ''
                        GROUP BY iata)`;

// ---- Slim rows + coordinates for the map -----------------------------------
seatsaeroRoutes.get("/api/seatsaero/routes/geo", async (c) => {
  const { source, where, binds } = routeFilter((k) => c.req.query(k));
  if (!source) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20000, 1), 50000);

  const from = `FROM seatsaero_routes r
                LEFT JOIN ${AIRPORT_PICK} ao ON ao.iata = r.origin
                LEFT JOIN ${AIRPORT_PICK} ad ON ad.iata = r.destination
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

  const body: ReachReport = assessGraphReach({
    routes: parsed,
    graph,
    fetched,
    programOf,
    totalSources: SEATSAERO_SOURCE_CATALOGUE.length,
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
       LEFT JOIN ${AIRPORT_PICK} ao ON ao.iata = r.origin
       LEFT JOIN ${AIRPORT_PICK} ad ON ad.iata = r.destination
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
