import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { AirportGeo, AirportInfo, AirportName } from "../../../shared/src/wire/index.js";
import { isLocalRequest } from "../middleware/security.js";

/**
 * The Library's Airports pane, the origin/destination autocompletes, and the
 * coordinates the trip list's route maps draw from.
 *
 * `airports` is standalone reference data — ~72k public-domain OurAirports rows,
 * generated into `seed/airports.sql` by `npm run build:airports`. Nothing here
 * touches a find, a snapshot or a coverage row.
 *
 * ROUTE ORDER IS LOAD-BEARING within this file: `/countries`, `/geo` and
 * `/lookup` are registered before the bare `/api/airports`, and Hono runs
 * matching handlers in registration order.
 *
 * `/countries` and `/geo` power the Airports pane ONLY — the origin/destination
 * autocompletes and the trip list's route maps call plain `/api/airports` and
 * `/api/airports/lookup` respectively, never these two. The Airports pane
 * itself is dev-only (`LibraryPage.tsx` swaps it for an "offline" message
 * outside `import.meta.env.DEV`), so these two answer `not_found` off loopback
 * the same way `POST /api/alerts/run` does — no reason to serve a ~72k-row
 * country breakdown or world geo dump to a host that has no UI to show it.
 */
export const airports = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- Airports: distinct countries (powers the country filter) ----
airports.get("/api/airports/countries", async (c) => {
  if (!isLocalRequest(c.req.url)) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT country, COUNT(*) AS count FROM airports
      WHERE country IS NOT NULL AND country != ''
      GROUP BY country ORDER BY country`,
  ).all<{ country: string; count: number }>();
  return c.json(results);
});

// Shared WHERE builder for the airport search — `q` is split into whitespace
// tokens; EACH token must match somewhere (AND), while within a token we OR
// across code/name/city/country/region (so "london heathrow" and "new york jfk"
// both work). Filters (type, continent, country, scheduled, iataOnly) further
// narrow the set. Uses anonymous `?` binds pushed in SQL order, so callers must
// append their own binds (ORDER BY, LIMIT) only AFTER these.
//
// Both `/api/airports` (table) and `/api/airports/geo` (map) call this, which is
// what keeps the two views showing the same set of airports once the user has
// searched. They differ only when NOTHING is selected: the table falls back to a
// browsable default of major airports (`defaultToMajors`), while the map wants
// the whole world plotted, so it opts out.
/**
 * A user's search box turned into an fts5 MATCH expression, or `null` when
 * nothing survives.
 *
 * fts5 has a query LANGUAGE, and the string arriving here is whatever someone
 * typed. Quoting is not enough on its own — a bare `AND`, `OR`, `NOT` or `NEAR`
 * is an operator, and `*`, `^`, `:`, `-`, `(`, `)` and `"` all mean something.
 * So each token is reduced to letters and digits, then quoted, then given the
 * one operator this app actually wants: a trailing `*` for prefix matching,
 * which is what an autocomplete is.
 *
 * Between terms the connective is left implicit, which in fts5 is AND. That is
 * the same rule the loop this replaced enforced by pushing one `where` clause
 * per token.
 *
 * Six tokens max, as before — an airport name is not a sentence, and the cap is
 * what stops a pasted paragraph becoming a 200-term query.
 *
 * Exported for its tests: this is the one place untrusted text becomes query
 * syntax, so it is worth pinning rather than reaching through `airportFilter`.
 */
export function ftsMatchQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.length ? terms.join(" ") : null;
}

function airportFilter(
  query: (k: string) => string | undefined,
  { defaultToMajors = true }: { defaultToMajors?: boolean } = {},
): {
  q: string;
  where: string[];
  binds: unknown[];
} {
  const q = (query("q") ?? "").trim();
  const iataOnly = query("iataOnly") === "1";
  const scheduledOnly = query("scheduled") === "1";
  const continent = (query("continent") ?? "").trim().toUpperCase();
  const country = (query("country") ?? "").trim().toUpperCase();
  const types = (query("type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const where: string[] = [];
  const binds: unknown[] = [];

  if (iataOnly) where.push("iata IS NOT NULL AND iata != ''");
  if (scheduledOnly) where.push("scheduled = 1");
  if (continent) {
    where.push("continent = ?");
    binds.push(continent);
  }
  if (country) {
    where.push("country = ?");
    binds.push(country);
  }
  if (types.length) {
    where.push(`type IN (${types.map(() => "?").join(", ")})`);
    binds.push(...types);
  }

  // FULL TEXT, replacing an eight-way OR per token.
  //
  // That chain was `iata = ? OR iata LIKE ? OR icao LIKE ? OR ident LIKE ? OR
  // name LIKE '%?%' OR city LIKE '%?%' OR country = ? OR region LIKE '%?%'`.
  // Three of those disjuncts had a LEADING wildcard, which no index can serve,
  // and one unindexable disjunct inside an OR forces the whole chain to a table
  // scan: 72,865 rows read to return 8, on every settled keystroke. See
  // migration 0006.
  //
  // fts5 keeps the semantics that mattered. Within a token the match is across
  // every indexed column — which is what the OR spelled out by hand — and
  // between tokens the default connective is AND, which is what pushing one
  // clause per token into `where` did. What changes: `name`/`city`/`region` go
  // from SUBSTRING to WORD-PREFIX, so "ternational" stops matching
  // "International" while "francisco" still matches "San Francisco Intl". That
  // is a better answer for an autocomplete, but it is a change.
  //
  // A `rowid IN (…)` predicate rather than a JOIN, deliberately: `airports_fts`
  // shares SIX column names with `airports`, so joining it would make `country =
  // ?`, `iata != ''` and every other clause in this builder ambiguous. As a
  // subquery, this builder's contract is unchanged — one more entry in `where`,
  // its bind pushed in SQL order — and both callers need no edit. `rowid` is
  // unambiguous in both: neither joins anything.
  if (q) {
    const match = ftsMatchQuery(q);
    if (match) {
      where.push("rowid IN (SELECT rowid FROM airports_fts WHERE airports_fts MATCH ?)");
      binds.push(match);
    } else {
      // `q` was punctuation only. It matched nothing under the LIKE chain
      // either, and saying so explicitly matters: `q` is non-empty, so the
      // `defaultToMajors` branch below will not catch it, and without this the
      // query would fall through to an unfiltered ranked top-N — a list of big
      // airports presented as if they were results.
      where.push("1 = 0");
    }
  }

  // No query and no filters → a browsable default of major airports.
  const hasFilters = iataOnly || scheduledOnly || continent || country || types.length > 0;
  if (defaultToMajors && !q && !hasFilters) {
    where.push("scheduled = 1", "type = 'large_airport'");
  }

  return { q, where, binds };
}

// ---- Airports: slim geo rows for the current search (powers the map) ----
// Same criteria as `/api/airports`, but minimal columns and no practical cap:
// the table shows the top ~100 matches while the map plots the whole matching
// set, clustered client-side. With no criteria at all this is the full ~72k-row
// dump (the map's default world view) — hence `defaultToMajors: false`.
airports.get("/api/airports/geo", async (c) => {
  if (!isLocalRequest(c.req.url)) return c.json({ error: "not_found" }, 404);
  const { where, binds } = airportFilter((k) => c.req.query(k), { defaultToMajors: false });
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100000, 1), 100000);

  const sql =
    `SELECT ident, iata, name, city, country, type, latitude, longitude, scheduled
       FROM airports
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL` +
    (where.length ? ` AND ${where.join(" AND ")}` : "") +
    " LIMIT ?";

  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<AirportGeo>();
  return c.json(results);
});

// ---- Airports: resolve a set of IATA codes in one round trip ----
// Deliberately NOT routed through `airportFilter`: that builder is a *search*,
// tuned for ranking partial matches and owning the "no query → major airports"
// default. This is an exact lookup for codes we already hold — the Routes page
// naming the airports on a tracked route, the trip list plotting them on a map —
// and wants none of that. Answers with whatever it finds; a code with no row is
// simply absent, which the caller renders as the bare code rather than as an
// error.
//
// Coordinates ride along with the names because both callers key off the same
// code set: a second endpoint for lat/lon would double the round trips to say
// something about airports this one has already found.
airports.get("/api/airports/lookup", async (c) => {
  const codes = [
    ...new Set(
      (c.req.query("codes") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{3}$/.test(s)),
    ),
    // A page of finds can hold 200 rows across many routes, and
    // every one of them names two to four airports. The cap is a guard against a
    // pathological query string, not a page size — set below what a real caller
    // asks for and the overflow is silent, which reads as a map that lost a
    // stop rather than as a truncated request.
  ].slice(0, 400);
  if (!codes.length) return c.json([]);

  const { results } = await c.env.DB.prepare(
    `SELECT iata, name, city, country, latitude, longitude FROM airports
      WHERE iata IN (${codes.map(() => "?").join(", ")})
      -- An IATA code can appear on more than one row in OurAirports (a heliport
      -- or closed field sharing it). Prefer the one that actually flies.
      ORDER BY scheduled DESC,
               CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1
                         WHEN 'small_airport' THEN 2 ELSE 3 END`,
  )
    .bind(...codes)
    .all<AirportName>();
  return c.json(results);
});

// ---- Airports: server-side ranked, multi-token search + filters ----
airports.get("/api/airports", async (c) => {
  const { q, where, binds } = airportFilter((k) => c.req.query(k));
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 200);
  const cols =
    "ident, type, name, iata, icao, city, country, region, continent, latitude, longitude, scheduled";

  let sql = `SELECT ${cols} FROM airports`;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

  const order: string[] = [];
  if (q) {
    order.push("(iata = ?) DESC");
    binds.push(q.toUpperCase());
  }
  order.push(
    "scheduled DESC",
    "CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1 WHEN 'small_airport' THEN 2 ELSE 3 END",
    "name",
  );
  sql += ` ORDER BY ${order.join(", ")} LIMIT ?`;
  binds.push(limit);

  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<AirportInfo>();
  return c.json(results);
});
