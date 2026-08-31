import type { AirportGeo, AirportInfo, AirportName } from "../../../shared/src/wire/index.js";
import type { QueryReader } from "../util/params.js";

/**
 * The `airports` table and its `airports_fts` index — ~72k public-domain
 * OurAirports rows, generated into `seed/airports.sql` by `npm run
 * build:airports`. Nothing here touches a find or a coverage claim.
 *
 * `airportFilter` is the WHERE builder the table read and the map read share,
 * which is what keeps the two views showing the same set once the user has
 * searched. It is module-private: both its callers are in this file, and its
 * contract is that a caller appends its own binds only AFTER these — a
 * positional rule nothing checks, and not one to publish worker-wide.
 * `ftsMatchQuery` IS exported, because it is the one place untrusted text
 * becomes query syntax and that is worth pinning with a test.
 */

/** Codes per statement in `selectAirportsByIata`. D1 allows 100 bound
 *  parameters per query and this binds one per code; two below the ceiling for
 *  headroom. See the chunking note at the call site. */
const LOOKUP_BIND_CHUNK = 98;

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

// Shared WHERE builder for the airport search — `q` is split into whitespace
// tokens; EACH token must match somewhere (AND), while within a token we OR
// across code/name/city/country/region (so "london heathrow" and "new york jfk"
// both work). Filters (type, continent, country, scheduled, iataOnly) further
// narrow the set. Uses anonymous `?` binds pushed in SQL order, so callers must
// append their own binds (ORDER BY, LIMIT) only AFTER these.
//
// Both the table read and the map read call this, which is what keeps the two
// views showing the same set of airports once the user has searched. They differ
// only when NOTHING is selected: the table falls back to a browsable default of
// major airports (`defaultToMajors`), while the map wants the whole world
// plotted, so it opts out.
function airportFilter(
  query: QueryReader,
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
  // Capped, because each surviving entry becomes one bound parameter and D1
  // allows 100 per query (see `db/finds.ts` for the arithmetic). Uncapped,
  // `?type=a,a,a,…` past the ceiling was a D1 error and so a 500. There are only
  // a handful of real OurAirports type values, so anything past this is noise
  // rather than a caller losing a filter.
  const types = (query("type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);

  const where: string[] = [];
  const binds: unknown[] = [];

  // `iata > ''` selects the same 9,054 rows as `iata IS NOT NULL AND iata != ''`
  // — NULL compares NULL and drops out, and every `iata` here is text or NULL, so
  // SQLite's cross-type ordering cannot widen it. The difference is that `!=` is
  // not sargable and `>` is, so the planner takes `idx_airports_iata` as a range
  // seek instead of scanning all 72,454 rows. That matters when there is no `q`
  // to drive the fts subquery, because then this clause is the whole WHERE:
  // measured 81,508 rows read against 18,108. With a `q` both forms measure 227.
  if (iataOnly) where.push("iata > ''");
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
  // the FTS index.
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
  // ?`, `iata > ''` and every other clause in this builder ambiguous. As a
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

/** Distinct countries, for the country filter. */
export async function selectAirportCountries(
  db: D1Database,
): Promise<{ country: string; count: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT country, COUNT(*) AS count FROM airports
        WHERE country IS NOT NULL AND country != ''
        GROUP BY country ORDER BY country`,
    )
    .all<{ country: string; count: number }>();
  return results;
}

/** Slim geo rows for the current search — what the map plots.
 *
 *  Same criteria as `selectAirports`, but minimal columns and no practical cap:
 *  the table shows the top ~100 matches while the map plots the whole matching
 *  set, clustered client-side. With no criteria at all this is the full ~72k-row
 *  dump (the map's default world view) — hence `defaultToMajors: false`. */
export async function selectAirportGeo(
  db: D1Database,
  query: QueryReader,
  limit: number,
): Promise<AirportGeo[]> {
  const { where, binds } = airportFilter(query, { defaultToMajors: false });

  const sql =
    `SELECT ident, iata, name, city, country, type, latitude, longitude, scheduled
       FROM airports
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL` +
    (where.length ? ` AND ${where.join(" AND ")}` : "") +
    " LIMIT ?";

  const { results } = await db
    .prepare(sql)
    .bind(...binds, limit)
    .all<AirportGeo>();
  return results;
}

/**
 * Resolve a set of IATA codes in one round trip.
 */
export async function selectAirportsByIata(
  db: D1Database,
  codes: readonly string[],
): Promise<AirportName[]> {
  if (!codes.length) return [];

  const sql = (n: number) =>
    `SELECT iata, name, city, country, latitude, longitude FROM airports
      WHERE iata IN (${Array.from({ length: n }, () => "?").join(", ")})
      -- An IATA code can appear on more than one row in OurAirports (a heliport
      -- or closed field sharing it). Prefer the one that actually flies.
      ORDER BY scheduled DESC,
               CASE type WHEN 'large_airport' THEN 0 WHEN 'medium_airport' THEN 1
                         WHEN 'small_airport' THEN 2 ELSE 3 END`;

  const chunks: (readonly string[])[] = [];
  for (let i = 0; i < codes.length; i += LOOKUP_BIND_CHUNK) {
    chunks.push(codes.slice(i, i + LOOKUP_BIND_CHUNK));
  }
  const batched = await db.batch<AirportName>(
    chunks.map((chunk) => db.prepare(sql(chunk.length)).bind(...chunk)),
  );
  return batched.flatMap((r) => r.results ?? []);
}

/** Server-side ranked, multi-token search + filters — what the table shows. */
export async function selectAirports(
  db: D1Database,
  query: QueryReader,
  limit: number,
): Promise<AirportInfo[]> {
  const { q, where, binds } = airportFilter(query);
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

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<AirportInfo>();
  return results;
}

/**
 * Coordinates for a set of airport codes.
 *
 * A plain join, not a `GROUP BY iata` derived table. That form was MATERIALIZED
 * per call — a full walk of `idx_airports_iata`'s 72,454 entries to look up a
 * handful of codes — and it was guarding against duplicate IATA codes that the
 * seed does not contain: 9,054 rows with a code and 9,054 distinct codes.
 * `scripts/build-airports.mjs` refuses to write a seed that would break that, so
 * the invariant is enforced where the data is made rather than re-derived in
 * every query that reads it.
 *
 * Codes are bound as JSON for the 100-parameter reason: a two-stop reach sweep
 * resolves every endpoint and hub at once.
 */
export async function airportCoords(
  db: D1Database,
  codes: readonly string[],
): Promise<Map<string, { lat: number; lon: number }>> {
  const wanted = [...new Set(codes)].filter(Boolean);
  if (!wanted.length) return new Map();

  const { results } = await db
    .prepare(
      `SELECT a.iata, a.latitude, a.longitude
         FROM json_each(?1) k
         JOIN airports a ON a.iata = k.value AND a.iata != ''`,
    )
    .bind(JSON.stringify(wanted))
    .all<{ iata: string; latitude: number | null; longitude: number | null }>();

  const out = new Map<string, { lat: number; lon: number }>();
  for (const row of results) {
    // A null coordinate is not a zero one. Null Island is in the Gulf of Guinea
    // and every distance measured from it would be wrong rather than missing.
    if (row.latitude === null || row.longitude === null) continue;
    out.set(row.iata, { lat: row.latitude, lon: row.longitude });
  }
  return out;
}
