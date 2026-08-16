import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import {
  AIRLINE_DIRECTORY,
  ALL_ALERT_TYPES,
  CURRENCIES,
  PORTAL_CURRENCIES,
  baselineOnEnable,
  normalizeSpec,
} from "../../shared/src/index.js";
import type { Env, Vars } from "./bindings.js";
import { identity } from "./auth.js";
import { authRoutes, gate } from "./gate.js";
import { applySecurityHeaders, corsOrigin, csrfOrigin } from "./security.js";
import { quota } from "./quota.js";
import { search } from "./search.js";
import { enrich } from "./enrich.js";
import { runAlertTick } from "./alerts/sweep.js";
import { alerts as alertRoutes } from "./alerts/routes.js";
import { isRecipientAllowed } from "./email.js";
import { FIND_COLUMNS, ROUTE_FINDS_MATCH, ROUTE_FINDS_SEATS, findsCte } from "./finds.js";

// THIS WORKER NEVER CALLS AN AIRLINE'S OWN SITE. The rule is about who is being
// scored: this Worker may call a service that authenticates the CREDENTIAL, and
// may not call one that judges the CLIENT. Carriers do the latter and refuse
// datacenter IPs outright — United answers Akamai 428 and Delta 444 to raw HTTP
// even from a residential connection, and Delta denies a real browser session
// replayed verbatim on top of that. Scraping them is over regardless; see
// docs/HARVEST-POSTMORTEM.md for why it was abandoned rather than fixed.
//
// It reaches exactly TWO hosts, and the split is the rule rather than an
// exception list:
//
//   INBOUND DATA — seats.aero's Partner API (`searchRun.ts`): a keyed, metered
//     vendor API that authenticates the key rather than the client.
//   OUTBOUND NOTIFICATION — Resend (`email.ts`): not a data source at all, but a
//     delivery channel, on exactly the same keyed-vendor footing.
//
// That test is now the ONLY gate on adding a source, because there is nowhere
// else for one to run. There used to be: a source whose posture against a
// datacenter IP was unmeasured declared `runtime: "local"`, ran from a laptop
// and POSTed to `/api/ingest/*`. PointsYeah was the one such source, and
// removing it took the runtime field, the ingest endpoints and INGEST_TOKEN
// with it. A source that cannot pass the credential-vs-client test does not get
// a different home now; it does not get added. docs/SOURCES.md.
//
// Something DOES run on a schedule: the alerts cron (`alerts/sweep.ts`, and the
// `scheduled` handler on the default export below) re-searches routes marked
// for alerts. That reverses a rule this comment used to state flatly, and
// docs/ALERTS.md §1 is the argument — including why the deleted quota budget
// guard came back with it, scoped to that one caller.

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Deployed the SPA is same-origin (this worker serves it, see the default export
// below) and this buys little. In dev the browser is on Vite's :5173, which
// proxies /api to wrangler's :8787 — also one origin as far as the browser is
// concerned. What this is really doing now is refusing everyone ELSE.
//
// `origin: "*"` had to go the moment the session became a cookie: a wildcard
// cannot be combined with credentials, and browsers reject the pair outright.
// `corsOrigin` echoes back only this worker's own origin (whichever host it is
// answering on) or the dev server. See security.ts.
app.use(
  "/api/*",
  cors({
    origin: corsOrigin,
    credentials: true,
    allowHeaders: ["Content-Type"],
  }),
);

// Belt to SameSite=Strict's braces. This only inspects requests a *form* could
// have made — the ones simple-CORS lets through without a preflight — so the
// SPA's JSON POSTs pass untouched, and the gap it closes is a form on someone
// else's page aimed at this API.
app.use("/api/*", csrf({ origin: csrfOrigin }));

app.get("/api/health", (c) => c.json({ ok: true, service: "bertbooker" }));

// The password gate's own routes, registered before the gate itself: Hono runs
// matching handlers in registration order and stops at the first that responds,
// so these (like /api/health above) never reach the middleware below.
app.route("/", authRoutes);

// Everything below requires the shared password.
app.use("/api/*", gate);

// ...and then an identity.
app.use("/api/*", identity);

// The metered sources' remaining daily allowance — what the app-bar chip reads.
// A plain read, covered by the password gate like any other.
app.route("/", quota);

// Searching a tracked route against seats.aero, streamed. Also after `identity`:
// a search is scoped to the caller's own routes and spends the shared API key.
app.route("/", search);

// Buying the itinerary behind a summary find, one seats.aero call at a time.
// Registered here purely so it reads next to `search`.
app.route("/", enrich);

// What the Alerts tab reads. In production it is read-only: the cron does the
// writing, and the only way to change what it does is to edit a route (PATCH
// below). The one exception is `POST /api/alerts/run`, which 404s off a loopback
// host — it is the development loop for `alerts/`, and it calls the same
// `runAlertTick` the cron does rather than a second implementation of a tick.
// See docs/ALERTS.md §9.
app.route("/", alertRoutes);

// ---- Reference data ----
// The couple's transferable currencies (reference constant, not per-user).
app.get("/api/currencies", (c) => c.json(CURRENCIES));

// Carriers with the programs that can book them, derived from the seed alliance
// table (reference constant, like CURRENCIES). Names/transfer partners for those
// program codes come from /api/programs, which is the editable D1 truth.
app.get("/api/airlines", (c) => c.json(AIRLINE_DIRECTORY));

app.get("/api/programs", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT code, name, kind, alliance, transfer_partners, is_active FROM programs WHERE is_active = 1 ORDER BY kind, name",
  ).all();
  return c.json(
    results.map((r) => ({ ...r, transfer_partners: JSON.parse(String(r.transfer_partners)) })),
  );
});

// ---- Airports: distinct countries (powers the country filter) ----
app.get("/api/airports/countries", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT country, COUNT(*) AS count FROM airports
      WHERE country IS NOT NULL AND country != ''
      GROUP BY country ORDER BY country`,
  ).all();
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

  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
  for (const tok of tokens) {
    const exact = tok.toUpperCase();
    const prefix = `${tok}%`;
    const contains = `%${tok}%`;
    where.push(
      "(iata = ? OR iata LIKE ? OR icao LIKE ? OR ident LIKE ? OR name LIKE ? OR city LIKE ? OR country = ? OR region LIKE ?)",
    );
    binds.push(exact, prefix, prefix, prefix, contains, contains, exact, contains);
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
app.get("/api/airports/geo", async (c) => {
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
    .all();
  return c.json(results);
});

// ---- Airports: resolve a set of IATA codes in one round trip ----
// Deliberately NOT routed through `airportFilter`: that builder is a *search*,
// tuned for ranking partial matches and owning the "no query → major airports"
// default. This is an exact lookup for codes we already hold — the dashboard
// naming the airports on a tracked route, the trip list plotting them on a map —
// and wants none of that. Answers with whatever it finds; a code with no row is
// simply absent, which the caller renders as the bare code rather than as an
// error.
//
// Coordinates ride along with the names because both callers key off the same
// code set: a second endpoint for lat/lon would double the round trips to say
// something about airports this one has already found.
app.get("/api/airports/lookup", async (c) => {
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
    .all();
  return c.json(results);
});

// ---- Airports: server-side ranked, multi-token search + filters ----
app.get("/api/airports", async (c) => {
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
    .all();
  return c.json(results);
});

// ---- Dashboard: monitors + best current finds ----
app.get("/api/dashboard", async (c) => {
  const email = c.get("userEmail");
  // Unscoped: the dashboard's join is what narrows to the user's routes, so the
  // collapse has to see every route they might be tracking. This is the one
  // caller that can't push a scope predicate down into the CTE.
  const dashboardFinds = findsCte({ where: [], binds: [] });
  // NOTE: `rows` is read POSITIONALLY below. Adding or removing a statement here
  // means renumbering the indices, and nothing in the type system will notice —
  // `D1Result[]` is homogeneous, so a mismatch hands one key another's rows.
  const rows = await c.env.DB.batch([
    c.env.DB.prepare(
      // The route-SET columns must be in this list. They are
      // what the Routes page draws the route's shape from, and an explicit
      // column list is exactly the kind that gets forgotten when a schema
      // change adds one: omitting them doesn't fail, it silently renders every
      // multi-airport route as a plain single-pair route.
      //
      // Since the header edits the route in place, this list is ALSO what the
      // edit form is seeded from — every settable column has to be here or its
      // field opens showing a default the row does not hold. `PATCH` merges
      // against the stored row, so the damage stops at the form; but a switch
      // that renders "off" for a route that is on is its own bug.
      //
      // The alert columns are exactly the case that warning was written about,
      // and they were missing from it. The edit dialog sends `alertsEnabled` on
      // every save rather than omitting it, so a form seeded from an absent
      // column sent `false` and QUIETLY UNENROLLED the route — and re-enabling
      // it afterwards re-ran `baselineOnEnable`, moving the digest clock too.
      // The last three are state rather than settings, and are here because the
      // Routes page draws a route's alert health beside it (see web/src/alerts.ts).
      "SELECT id, origin, destination, origins, destinations," +
        " date_start, date_end, cabins, currencies, min_seats, direct_only, round_trip," +
        " last_checked_at," +
        " alerts_enabled, alert_email, alert_on, alert_min_drop_pct," +
        " alert_last_attempt_at, alert_last_digest_at, alert_consecutive_failures" +
        " FROM tracked_routes WHERE user_email = ? ORDER BY created_at DESC",
    ).bind(email),
    // Current finds, tied to the routes that monitor them. `findsCte` collapses
    // the per-source snapshot history into one current row per
    // (route_key, program, cabin) — see finds.ts for why that collapse now
    // happens at read time — and this joins the result to the user's
    // tracked_routes by origin + destination + date window, constrained to each
    // route's own cabin and min-seats. Tagged with tracked_route_id so the UI
    // can nest each find under its route; a find overlapping two routes'
    // windows appears under both.
    c.env.DB.prepare(
      `${dashboardFinds.sql}
       SELECT tr.id AS tracked_route_id, ${FIND_COLUMNS}
         FROM finds f
         JOIN tracked_routes tr
           ON tr.user_email = ?
          -- "Does this find belong to this route, and pass its filters?" —
          -- shared verbatim with the alert sweep, which asks the identical
          -- question about one route. See ROUTE_FINDS_MATCH in finds.ts for why
          -- that sharing is load-bearing rather than tidy.
          AND ${ROUTE_FINDS_MATCH}
        WHERE ${ROUTE_FINDS_SEATS}
        ORDER BY tr.id, f.flight_date ASC, f.seats_available DESC, f.miles_cost ASC`,
    ).bind(...dashboardFinds.binds, email, JSON.stringify(PORTAL_CURRENCIES)),
  ]);
  return c.json({
    trackedRoutes: rows[0]?.results ?? [],
    bestFinds: rows[1]?.results ?? [],
  });
});

// ---- Tracked routes (saved searches) ----
app.get("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tracked_routes WHERE user_email = ? ORDER BY created_at DESC",
  )
    .bind(email)
    .all();
  return c.json(results);
});

/** What a route is, on the wire. `POST` requires the window; `PATCH` treats every
 *  field as optional and merges against the stored row. */
interface RouteBody {
  origin?: string;
  destination?: string;
  /** The authoritative airport sets. `origin`/`destination` remain accepted so
   *  an older client still works, and are the fallback when these are absent. */
  origins?: string[] | null;
  destinations?: string[] | null;
  dateStart?: string;
  dateEnd?: string;
  cabins?: string[] | null;
  minSeats?: number;
  programs?: string[] | null;
  currencies?: string[] | null;
  kind?: string;
  /** Show only nonstop finds under this route. A read filter; see the migration. */
  directOnly?: boolean;
  /** Search BOTH directions. A gathering setting, not a read filter — turning
   *  it on needs a re-search before the return legs exist. */
  roundTrip?: boolean;
  /** Email me when this route changes. The second setting that changes what is
   *  GATHERED rather than what is shown: it enrolls the route in the cron sweep.
   *  See docs/ALERTS.md. */
  alertsEnabled?: boolean;
  /** Where the digest goes. Empty/null = the account's own address. Checked
   *  against ALERT_ALLOWED_RECIPIENTS. */
  alertEmail?: string | null;
  /** Which transitions fire. `undefined` keeps what is stored; `null` resets to
   *  the default set. An EMPTY ARRAY is refused — see below. */
  alertOn?: string[] | null;
  alertMinDropPct?: number;
}

/**
 * Validate the alert settings shared by POST and PATCH.
 *
 * The empty-array rule is the one worth stating. Every other list column here
 * (`cabins`, `currencies`) treats `[]` as "no filter, everything matches", and
 * copying that convention would make `alert_on: []` mean *nothing ever fires* —
 * a route that looks armed and is silent forever, which is the single most
 * plausible way for this feature to appear broken while behaving exactly as
 * configured. So it is a 400 rather than a stored value, and `null` is the only
 * way to ask for the default set.
 */
function validateAlerts(
  b: RouteBody,
  env: Env,
): { ok: true } | { ok: false; error: string; message: string } {
  if (b.alertOn !== undefined && b.alertOn !== null) {
    if (!Array.isArray(b.alertOn) || b.alertOn.length === 0) {
      return {
        ok: false,
        error: "bad_alert_types",
        message: "Choose at least one kind of change to be told about.",
      };
    }
    const unknown = b.alertOn.filter((t) => !(ALL_ALERT_TYPES as string[]).includes(t));
    if (unknown.length) {
      return { ok: false, error: "bad_alert_types", message: `Unknown: ${unknown.join(", ")}` };
    }
  }
  if (b.alertEmail) {
    if (!isRecipientAllowed(env, b.alertEmail)) {
      return {
        ok: false,
        error: "recipient_not_allowed",
        message: `${b.alertEmail} is not in ALERT_ALLOWED_RECIPIENTS.`,
      };
    }
  }
  return { ok: true };
}

/** 0–100, and a whole number: a fractional percentage threshold is a decision
 *  nobody makes and a column nobody can read back. */
const clampDropPct = (v: number | undefined, fallback: number): number =>
  v === undefined ? fallback : Math.min(Math.max(Math.round(v), 0), 100);

/** A stored JSON array column back into a code list. Never throws: a route whose
 *  `origins` somehow isn't JSON should edit as unset, not 500. */
function storedList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

app.post("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  const b = await c.req.json<RouteBody & { dateStart: string; dateEnd: string }>();
  const cabins = b.cabins?.length ? b.cabins : null;

  const alerts = validateAlerts(b, c.env);
  if (!alerts.ok) return c.json({ error: alerts.error, message: alerts.message }, 400);

  // Validate through the same pure function the search planner uses, so a route
  // that cannot be planned cannot be stored. It throws rather than truncating —
  // a silently dropped third origin would make the route search less than it
  // claims to, and claim coverage for a set nobody chose.
  let spec: ReturnType<typeof normalizeSpec>;
  try {
    spec = normalizeSpec({
      origins: b.origins?.length ? b.origins : [b.origin ?? ""],
      destinations: b.destinations?.length ? b.destinations : [b.destination ?? ""],
    });
  } catch (err) {
    return c.json({ error: "bad_route_spec", message: (err as Error).message }, 400);
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO tracked_routes
       (user_email, origin, destination, origins, destinations,
        date_start, date_end, cabin, cabins, min_seats, programs, currencies, kind, direct_only,
        round_trip, alerts_enabled, alert_email, alert_on, alert_min_drop_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      email,
      // Legacy scalars (NOT NULL), kept as the route's PRIMARY airport — the same
      // representative-value trick `cabin` uses below. `search_runs` and the
      // pre-0013 read paths still key off these.
      spec.origins[0]!,
      spec.destinations[0]!,
      JSON.stringify(spec.origins),
      JSON.stringify(spec.destinations),
      b.dateStart,
      b.dateEnd,
      // Legacy scalar `cabin` (NOT NULL): kept in sync as a representative value
      // for any SELECT * reader; `cabins` is the authoritative filter now.
      cabins?.length === 1 ? cabins[0] : "any",
      // Store NULL (not "[]") when no filter, so downstream "no filter" checks
      // and the dashboard join treat an empty selection as "any cabin".
      cabins ? JSON.stringify(cabins) : null,
      Math.min(Math.max(Math.round(b.minSeats ?? 2), 1), 9),
      b.programs?.length ? JSON.stringify(b.programs) : null,
      // Same NULL-when-empty rule for the currency filter ("any currency").
      b.currencies?.length ? JSON.stringify(b.currencies) : null,
      b.kind ?? "flight",
      b.directOnly ? 1 : 0,
      // Unlike every other flag bound here, this one changes what a search
      // GATHERS: both directions in the one call. See migrations/0004.
      b.roundTrip ? 1 : 0,
      // ...and so does this one: it enrolls the route in the cron sweep.
      b.alertsEnabled ? 1 : 0,
      b.alertEmail?.trim() || null,
      // NULL means the default set. `[]` was already refused above.
      b.alertOn?.length ? JSON.stringify(b.alertOn) : null,
      clampDropPct(b.alertMinDropPct, 5),
    )
    .first<{ id: number }>();
  return c.json({ id: res?.id }, 201);
});

/**
 * Edit a stored route — the header's edit mode, and the only writer besides the
 * Add dialog.
 *
 * A **merge then whole-row write**, not a per-column patch. The reason is
 * `normalizeSpec`: it validates the airport sets as one shape, so it has to be
 * handed the route the caller means to end up with, not the two fields they
 * touched.
 * The stored row is therefore read first and anything absent from the body kept
 * from it. An absent field means "leave it"; an empty array means "clear the
 * filter", which is why the two are distinguished rather than collapsed.
 *
 * Nothing here touches a snapshot, a coverage row or `last_checked_at`. Editing
 * a route re-asks the question; it never invalidates an answer — a narrowed
 * window simply stops joining to finds that are still stored, and widening it
 * back shows them again with no search.
 */
app.patch("/api/tracked-routes/:id", async (c) => {
  const email = c.get("userEmail");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<RouteBody>();

  const alerts = validateAlerts(b, c.env);
  if (!alerts.ok) return c.json({ error: alerts.error, message: alerts.message }, 400);

  const row = await c.env.DB.prepare(
    "SELECT * FROM tracked_routes WHERE id = ? AND user_email = ?",
  )
    .bind(id, email)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const merged = {
    origins: b.origins?.length
      ? b.origins
      : b.origins === undefined
        ? (storedList(row.origins).length ? storedList(row.origins) : [String(row.origin)])
        : [],
    destinations: b.destinations?.length
      ? b.destinations
      : b.destinations === undefined
        ? (storedList(row.destinations).length
            ? storedList(row.destinations)
            : [String(row.destination)])
        : [],
  };

  let spec: ReturnType<typeof normalizeSpec>;
  try {
    spec = normalizeSpec(merged);
  } catch (err) {
    return c.json({ error: "bad_route_spec", message: (err as Error).message }, 400);
  }

  const alertsEnabled =
    b.alertsEnabled === undefined ? Number(row.alerts_enabled ?? 0) : b.alertsEnabled ? 1 : 0;

  const dateStart = b.dateStart ?? String(row.date_start);
  const dateEnd = b.dateEnd ?? String(row.date_end);
  if (dateEnd < dateStart) {
    return c.json({ error: "bad_window", message: "The window ends before it starts." }, 400);
  }

  // `undefined` keeps what is stored; `[]` (or null) clears the filter to "any".
  const cabins =
    b.cabins === undefined
      ? (row.cabins as string | null)
      : b.cabins?.length
        ? JSON.stringify(b.cabins)
        : null;
  const currencies =
    b.currencies === undefined
      ? (row.currencies as string | null)
      : b.currencies?.length
        ? JSON.stringify(b.currencies)
        : null;

  await c.env.DB.prepare(
    `UPDATE tracked_routes
        SET origin = ?, destination = ?, origins = ?, destinations = ?,
            date_start = ?, date_end = ?,
            cabin = ?, cabins = ?, currencies = ?, min_seats = ?, direct_only = ?,
            round_trip = ?,
            alerts_enabled = ?, alert_email = ?, alert_on = ?, alert_min_drop_pct = ?,
            -- Turning alerts ON re-decides the baseline. A route that has been
            -- dark has a stale per-source snapshot, so its next diff would call
            -- everything new and email a wall of it; clearing the digest clock
            -- makes the next sweep a silent baseline. But a route somebody
            -- searched RECENTLY already holds the snapshot a baseline sweep
            -- would go and fetch, so baselineOnEnable stamps the clock instead
            -- and the very next sweep can email real changes. See its docblock —
            -- the baseline is the snapshot, this column is only the suppression.
            -- (No backticks in here — this is a template literal.)
            alert_last_digest_at = CASE WHEN ? = 1 AND alerts_enabled = 0
                                        THEN ? ELSE alert_last_digest_at END,
            -- A settings change is a fresh start for the back-off too; otherwise
            -- fixing a broken window would still wait out the old penalty.
            alert_consecutive_failures = 0
      WHERE id = ? AND user_email = ?`,
  )
    .bind(
      // The legacy scalars stay the PRIMARY airport of each side, exactly as on
      // insert: they are NOT NULL and other readers still key off them.
      spec.origins[0]!,
      spec.destinations[0]!,
      JSON.stringify(spec.origins),
      JSON.stringify(spec.destinations),
      dateStart,
      dateEnd,
      // Representative value for any `SELECT *` reader; `cabins` is the filter.
      cabins ? (storedList(cabins).length === 1 ? storedList(cabins)[0] : "any") : "any",
      cabins,
      currencies,
      Math.min(Math.max(Math.round(b.minSeats ?? Number(row.min_seats ?? 1)), 1), 9),
      b.directOnly === undefined ? Number(row.direct_only ?? 0) : b.directOnly ? 1 : 0,
      b.roundTrip === undefined ? Number(row.round_trip ?? 0) : b.roundTrip ? 1 : 0,
      alertsEnabled,
      b.alertEmail === undefined
        ? (row.alert_email as string | null)
        : b.alertEmail?.trim() || null,
      // `undefined` keeps what is stored; `null` resets to the default set. `[]`
      // was refused above rather than stored as "never fire".
      b.alertOn === undefined
        ? (row.alert_on as string | null)
        : b.alertOn?.length
          ? JSON.stringify(b.alertOn)
          : null,
      clampDropPct(b.alertMinDropPct, Number(row.alert_min_drop_pct ?? 5)),
      alertsEnabled,
      // Only consulted by the CASE above, i.e. only on an OFF -> ON transition.
      baselineOnEnable(row.last_checked_at == null ? null : Number(row.last_checked_at), Date.now()),
      id,
      email,
    )
    .run();

  return c.json({ ok: true });
});

app.delete("/api/tracked-routes/:id", async (c) => {
  const email = c.get("userEmail");
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM tracked_routes WHERE id = ? AND user_email = ?")
    .bind(id, email)
    .run();
  return c.json({ ok: true });
});

/*
 * `POST /api/tracked-routes/:id/search` lives in `search.ts`.
 *
 * It once lived here, running every provider inline and streaming NDJSON back,
 * and was moved out when it became clear a Worker cannot read a carrier's own
 * site: United returns Akamai 428 and Delta 444 even from a residential IP. That
 * part has not changed, and scraping is no longer attempted at all — see
 * docs/HARVEST-POSTMORTEM.md for why it was abandoned rather than fixed.
 *
 * What the Worker does run rests on a different fact: seats.aero is a keyed
 * vendor API, not a carrier site, and does not care where the request
 * originates. So a tracked route is something the server can execute.
 */

/*
 * There were two more routes here — `GET /api/finds`, a paged query over every
 * stored find, and `GET /api/finds/sources`, a tally of who had ever written
 * one. Both backed a general database browser that was removed as a worse
 * duplicate of the dashboard's own reader, and both then sat with no SPA caller
 * and no test for long enough that nothing would have noticed either breaking.
 *
 * They are gone rather than kept-just-in-case. `findsCte` is still the one
 * reader every surface shares (`finds.ts`); the dashboard is now the only
 * caller of it, which means a change to that CTE is exercised by the surface
 * that matters instead of by an endpoint nobody was watching.
 */

/**
 * Everything above is the API. Everything else this worker answers is the SPA,
 * served from the `ASSETS` binding (`web/dist`, see wrangler.toml) — one worker,
 * one origin, which is what lets `web/src/api.ts` keep fetching relative
 * `/api/…` paths with no base URL and no CORS in production.
 *
 * **`export default app` does NOT work here, and the failure is quiet.** Static
 * assets are matched before this worker runs, so a request for `/library`
 * matches no file and arrives *here* — where Hono, having no such route, answers
 * its own 404 and the deep link breaks while the app itself looks fine. Handing
 * the request to `env.ASSETS.fetch()` is what applies
 * `not_found_handling = "single-page-application"` and returns index.html.
 * randyleague shipped this bug first (commit e6b9801, "fix spa 404s").
 *
 * `scheduled` is a SIBLING KEY on this same object, and it shares none of the
 * above: no Hono, no middleware, no `applySecurityHeaders` — see its own
 * docblock. Adding a handler here is adding a key, not wrapping `fetch`.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Canonical host. Both `bertbooker.com` and `www.bertbooker.com` are routed
    // to this worker (wrangler.toml) so that either spelling resolves, but only
    // the apex is ever SERVED: the session is an HttpOnly SameSite=Strict cookie
    // scoped to the host that set it, so answering on both would mean two
    // independent logins depending on which one you typed.
    //
    // 308 rather than 301 — permanent either way, but 308 forbids the
    // method-rewrite-to-GET that 301 historically permits, so a POST that lands
    // on the wrong host replays as a POST instead of silently becoming a GET.
    // Matched on the `www.` prefix rather than a literal, so it needs no edit if
    // the domain moves again.
    let canonical: URL | null = null;
    if (url.hostname.startsWith("www.")) {
      canonical = new URL(url);
      canonical.hostname = url.hostname.slice(4);
    }

    // Security headers are applied HERE rather than as Hono middleware, and the
    // difference matters: Hono only sees `/api/*`, so middleware would stamp the
    // JSON and miss the HTML document — the one response a CSP is actually
    // about. Every branch below goes through the same helper.
    const respond = async (): Promise<Response> => {
      // Before anything else, including the API: nothing should be answered on
      // the non-canonical host. It goes through `respond` rather than returning
      // early so the redirect carries the same headers as everything else —
      // notably HSTS, which is the one header that has to reach a browser on
      // its FIRST visit to `www.` to be worth anything.
      if (canonical) return Response.redirect(canonical.toString(), 308);

      if (pathname.startsWith("/api/")) return app.fetch(request, env, ctx);

      return env.ASSETS.fetch(request);
    };

    return applySecurityHeaders(await respond(), url);
  },

  /**
   * The cron tick — the only unattended work in this app. See docs/ALERTS.md.
   *
   * **No middleware runs here.** Not `cors`, not `csrf`, not `gate`, not
   * `identity`, and not `applySecurityHeaders` — none of those are on a code
   * path a `scheduled` invocation takes. So identity is read straight off
   * `env.APP_USER_EMAIL`, and `runAlertTick` fails closed when it is unset
   * exactly as the gate would, because `search_runs.user_email` is NOT NULL and
   * there would be no account to attribute a sweep to.
   *
   * `await`, deliberately, and NOT `ctx.waitUntil`. An async `scheduled`
   * handler's returned promise is already awaited by the runtime, so
   * `waitUntil` buys nothing — while awaiting is what makes a thrown tick show
   * up as a FAILED invocation in Workers Logs. That matters more here than
   * anywhere else in this worker: no email is ever sent about a failed sweep, so
   * the logs and the Alerts tab are the only two places a broken scheduler is
   * visible at all.
   */
  async scheduled(_controller, env, _ctx) {
    await runAlertTick(env);
  },
} satisfies ExportedHandler<Env>;
