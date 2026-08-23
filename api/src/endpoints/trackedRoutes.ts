import { Hono } from "hono";
import { ALL_ALERT_TYPES } from "../alerts/select.js";
import { baselineOnEnable } from "../alerts/pace.js";
import { MAX_VIA, normalizeSpec, searchPairs } from "../domain/routing.js";
import { fetchedSources, graphRowsForPairs, readFetchRecords } from "../db/routeGraph.js";
import { searchGraphPaths } from "../search/graphPaths.js";
import { isRecipientAllowed } from "../alerts/email.js";
import { isIsoDate } from "../providers/window.js";
import { CABIN_ORDER } from "../domain/types.js";
import { CURRENCIES } from "../domain/programs.js";
import { rowIdParam } from "./params.js";
import type { Env, Vars } from "../bindings.js";
import type { RouteInput, TrackedRoute } from "../../../shared/src/wire/index.js";

/**
 * Tracked routes — the saved searches everything else in the app hangs off.
 *
 * The two writers here are the Add dialog and the header's edit mode, and they
 * are deliberately asymmetric: `POST` requires the date window, while `PATCH`
 * treats every field as optional and merges against the stored row. See
 * `RouteBody` below for the three ways this differs from the SPA's `RouteInput`,
 * and the assertion under it that keeps the two in step.
 *
 * `POST /api/tracked-routes/:id/search` and `/enrich` are NOT here — they are
 * `endpoints/search.ts` and `endpoints/enrich.ts`, mounted before this module so
 * their more specific paths are matched first.
 */
export const trackedRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- Tracked routes (saved searches) ----
trackedRoutes.get("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tracked_routes WHERE user_email = ? ORDER BY created_at DESC",
  )
    .bind(email)
    .all<TrackedRoute>();
  return c.json(results);
});

/**
 * What a route is, on the wire. `POST` requires the window; `PATCH` treats every
 * field as optional and merges against the stored row.
 *
 * **Deliberately NOT the same type as `RouteInput`** in
 * `shared/src/wire/rows.ts`, which is what the SPA's form sends. This is what
 * the Worker ACCEPTS, and it is a wider, older shape in three ways that all
 * still matter: the pre-sets scalar `origin`/`destination`; `programs` and
 * `kind`, which no current client sends; and `null` as an explicit "clear this
 * filter", which is a distinct instruction from an absent field's "leave it
 * alone". Collapsing the two would have to give one of those up.
 *
 * `alertOn` is `string[]` and not `AlertType[]` for the same reason: this
 * describes what ARRIVED, not what is legal. `validateAlerts` below is what
 * turns one into the other.
 *
 * The assertion under the interface is what keeps them in step.
 */
interface RouteBody {
  origin?: string;
  destination?: string;
  /** The authoritative airport sets. `origin`/`destination` remain accepted so
   *  an older client still works, and are the fallback when these are absent. */
  origins?: string[] | null;
  destinations?: string[] | null;
  /**
   * Hubs to route through, at most `MAX_VIA`.
   *
   * Three-valued, and all three mean different things. **Absent** = "work it
   * out": the Worker asks the route graph and fills in the best hubs, which is
   * the whole point — a route on a pair nobody monitors should not need the user
   * to know that, or to know which hubs. **An empty array** = "no hubs, I mean
   * it", and is never auto-filled over. **A list** is taken as given.
   */
  via?: string[] | null;
  dateStart?: string;
  dateEnd?: string;
  cabins?: string[] | null;
  minSeats?: number;
  programs?: string[] | null;
  currencies?: string[] | null;
  kind?: string;
  /** Show only nonstop finds under this route. A read filter; see the migration. */
  directOnly?: boolean;
  /** The most miles an award may cost to be shown. A read filter; see
   *  migrations/0007. Three-valued like the list filters above: absent keeps
   *  what is stored, `null` clears the limit, a number sets it. */
  pointLimit?: number | null;
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
 * Everything the SPA can send, this handler must accept.
 *
 * A compile-time assertion and nothing else — it emits no code. `RouteInput`
 * (the SPA's form contract) and `RouteBody` (what this route parses) are allowed
 * to differ, but only in the direction of this being wider. Add a field to
 * `RouteInput`, or change one's type, and this line fails rather than the
 * mismatch reaching a handler that silently ignores it. That is the check the
 * hand-mirrored pair never had.
 */
type Assert<T extends true> = T;
type _RouteInputIsAcceptable = Assert<RouteInput extends RouteBody ? true : false>;

/**
 * The hubs a route should monitor, worked out from the route graph.
 *
 * Called only when the client sent no `via` at all, and only for a one-way
 * route. What it answers is "does anybody actually sell this pair" — and when
 * nobody does, which stops would fix it. A pair somebody monitors gets NO hubs:
 * the search already finds its connections, because seats.aero returns
 * connecting itineraries within a monitored market, and a second query would be
 * spent asking about a market the first one already covers.
 *
 * Costs nothing. Every read below is D1, over the graph the Tools page already
 * bought. Failure is silent and yields no hubs: a route must be creatable on a
 * day the route graph is empty, and "no hubs" is exactly what an unfetched graph
 * should conclude.
 */
async function autoVia(
  db: D1Database,
  spec: { origins: string[]; destinations: string[] },
  roundTrip: boolean,
): Promise<string[]> {
  if (roundTrip) return [];
  try {
    const pairs = searchPairs(spec, false);
    if (!pairs.length) return [];

    const records = await readFetchRecords(db);
    const fetched = new Set(fetchedSources(records));
    if (!fetched.size) return [];

    // A pair anybody monitors needs no hubs — see above.
    const direct = await graphRowsForPairs(db, pairs);
    const flown = new Set(
      direct.filter((r) => fetched.has(r.source)).map((r) => `${r.origin}>${r.destination}`),
    );
    const gaps = pairs.filter((p) => !flown.has(`${p.origin}>${p.destination}`));
    if (!gaps.length) return [];

    const { results } = await searchGraphPaths(db, gaps, { fetched, maxStops: 2 });

    // Hubs in the order the paths were RANKED — shortest detour first — deduped
    // across a multi-airport route's several gap pairs, and capped. `planRoute`
    // caps again, because this is not the only way a `via` can arrive.
    const hubs: string[] = [];
    for (const pair of gaps) {
      const found = results.get(`${pair.origin}>${pair.destination}`);
      for (const path of found?.paths ?? []) {
        for (const hub of path.via) {
          if (!hubs.includes(hub)) hubs.push(hub);
          if (hubs.length >= MAX_VIA) return hubs;
        }
      }
    }
    return hubs;
  } catch {
    // A route that cannot be priced is still a route worth saving.
    return [];
  }
}

/** `via` as it should be STORED: null for none, JSON otherwise. Null rather than
 *  `"[]"` so the column reads the way `cabins` and `currencies` do, and so
 *  `parseCodeList` needs no special case. */
const viaColumn = (hubs: string[]): string | null =>
  hubs.length ? JSON.stringify(hubs.slice(0, MAX_VIA)) : null;

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
    // Bounded as well as checked. The membership test below rejects unknown
    // VALUES but said nothing about how many, so `["new"]` repeated a hundred
    // thousand times passed and was stringified into the column — and
    // `alert_on` is re-parsed by every sweep. There are only so many distinct
    // kinds of change, so the list of them is its own cap.
    if (Array.isArray(b.alertOn) && b.alertOn.length > ALL_ALERT_TYPES.length) {
      return {
        ok: false,
        error: "bad_alert_types",
        message: "Too many alert kinds.",
      };
    }
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

/**
 * The JSON list columns, bounded and — where the vocabulary is closed — checked
 * against it.
 *
 * `cabins`, `currencies` and `programs` were stringified straight out of the
 * request body with no cap on length and no check on content at all. They are
 * re-parsed by `json_each` in every `ROUTE_FINDS_MATCH` scan and by every
 * sweep, so a multi-megabyte array is not merely an odd-looking row: it is a
 * cost paid on every read of the Routes page, for as long as the route exists,
 * by a route that looks entirely normal in the UI.
 *
 * VALIDATION ONLY — nothing is normalised or rewritten here, so PATCH's
 * three-valued merge downstream (`undefined` keeps what is stored, `[]` clears
 * the filter to "any") is untouched.
 *
 * `programs` is bounded but deliberately NOT allowlisted: the `programs` table
 * is editable reference data, so a fixed list here would fight it, and an
 * unknown code only ever narrows a filter to nothing.
 */
function validateLists(b: RouteBody): { ok: true } | { ok: false; message: string } {
  const checks: [string, unknown, readonly string[] | null, number][] = [
    ["cabins", b.cabins, CABIN_ORDER, CABIN_ORDER.length],
    ["currencies", b.currencies, CURRENCY_CODES, CURRENCY_CODES.length],
    ["programs", b.programs, null, 64],
  ];
  for (const [label, value, allowed, cap] of checks) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return { ok: false, message: `${label} must be a list.` };
    if (value.length > cap) {
      return { ok: false, message: `Too many ${label} (at most ${cap}).` };
    }
    if (allowed) {
      const unknown = [...new Set(value.map(String))].filter((v) => !allowed.includes(v));
      if (unknown.length) {
        return { ok: false, message: `Unknown ${label}: ${unknown.join(", ")}` };
      }
    }
  }
  return { ok: true };
}

/** The currency codes a route may filter on — derived from the one catalogue in
 *  `domain/programs.ts` rather than restated, so adding a currency there is the
 *  whole of adding it. */
const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code);

/** 0–100, and a whole number: a fractional percentage threshold is a decision
 *  nobody makes and a column nobody can read back.
 *
 *  `Number.isFinite` first, for the reason `clampPointLimit` below spells out:
 *  `Math.round(NaN)` is `NaN`, and `NaN` passes straight through `Math.min` and
 *  `Math.max` untouched. Written as a bare clamp chain over an untrusted body
 *  field — which is how this was written — a non-numeric value reached a NOT
 *  NULL INTEGER column. */
const clampDropPct = (v: unknown, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(Math.round(v as number), 0), 100) : fallback;

/** Seats per booking as it will be stored: a whole number, 1–9. Same
 *  `Number.isFinite` guard and the same reason as `clampDropPct` above — this
 *  was the second bare clamp chain, written out twice (POST and PATCH). */
const clampMinSeats = (v: unknown, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(Math.round(v as number), 1), 9) : fallback;

/**
 * A points ceiling as it will be stored: a positive whole number, or NULL for
 * no limit.
 *
 * Three-valued in, two-valued out. `undefined` means "leave it alone" and never
 * reaches here; `null` clears it. **Zero and anything negative clear it too**,
 * rather than being stored — a route that hides every find it has looks exactly
 * like a broken one, which is the same reasoning that refuses an empty
 * `alert_on`. The upper bound is generous on purpose: it exists to keep a typo
 * out of an INTEGER column, not to have an opinion about award charts.
 */
const clampPointLimit = (v: number | null | undefined, fallback: number | null): number | null => {
  if (v === undefined) return fallback;
  if (v === null || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n > 0 ? Math.min(n, 100_000_000) : null;
};

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

trackedRoutes.post("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  const b = await c.req
    .json<RouteBody & { dateStart: string; dateEnd: string }>()
    .catch(() => null);
  if (!b) return c.json({ error: "bad_body" }, 400);
  const cabins = b.cabins?.length ? b.cabins : null;

  const alerts = validateAlerts(b, c.env);
  if (!alerts.ok) return c.json({ error: alerts.error, message: alerts.message }, 400);

  const lists = validateLists(b);
  if (!lists.ok) return c.json({ error: "bad_list", message: lists.message }, 400);

  // THE DATE WINDOW, checked here and not only on PATCH.
  //
  // This endpoint used to bind `b.dateStart` / `b.dateEnd` verbatim. `c.req
  // .json<T>()` does no runtime checking — `T` is an assertion about the parsed
  // value, not a validation of it — so any string at all was stored. It was then
  // read back by `addDaysISO` through `routeFindsScope` (db/finds.ts), where it
  // threw. One malformed POST therefore 500'd `GET /api/routes` — the main page —
  // along with every search and every cron tick, permanently, and the only
  // repair was deleting the row by hand. Cheap to store, expensive to survive.
  if (!isIsoDate(b.dateStart) || !isIsoDate(b.dateEnd)) {
    return c.json(
      { error: "bad_window", message: "Give a start and end date as YYYY-MM-DD." },
      400,
    );
  }
  if (b.dateEnd < b.dateStart) {
    return c.json({ error: "bad_window", message: "The window ends before it starts." }, 400);
  }

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

  // An ABSENT `via` means "work it out"; an empty array means "no hubs". So a
  // route created anywhere — this dialog, the Tools page, a bare POST — arrives
  // already knowing how to reach a pair nobody sells, without its creator having
  // to know that it doesn't.
  const via =
    b.via === undefined
      ? await autoVia(c.env.DB, spec, Boolean(b.roundTrip))
      : (b.via ?? []);

  const res = await c.env.DB.prepare(
    `INSERT INTO tracked_routes
       (user_email, origin, destination, origins, destinations, via,
        date_start, date_end, cabin, cabins, min_seats, programs, currencies, kind, direct_only,
        point_limit, round_trip, alerts_enabled, alert_email, alert_on, alert_min_drop_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      email,
      // Legacy scalars (NOT NULL), kept as the route's PRIMARY airport — the same
      // representative-value trick `cabin` uses below. `search_runs` and other
      // readers still key off these.
      spec.origins[0]!,
      spec.destinations[0]!,
      JSON.stringify(spec.origins),
      JSON.stringify(spec.destinations),
      viaColumn(via),
      b.dateStart,
      b.dateEnd,
      // Legacy scalar `cabin` (NOT NULL): kept in sync as a representative value
      // for any SELECT * reader; `cabins` is the authoritative filter now.
      cabins?.length === 1 ? cabins[0] : "any",
      // Store NULL (not "[]") when no filter, so downstream "no filter" checks
      // and the Routes page join treat an empty selection as "any cabin".
      cabins ? JSON.stringify(cabins) : null,
      clampMinSeats(b.minSeats, 2),
      b.programs?.length ? JSON.stringify(b.programs) : null,
      // Same NULL-when-empty rule for the currency filter ("any currency").
      b.currencies?.length ? JSON.stringify(b.currencies) : null,
      b.kind ?? "flight",
      b.directOnly ? 1 : 0,
      // NULL = no limit, which is what a route with no opinion gets.
      clampPointLimit(b.pointLimit, null),
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
trackedRoutes.patch("/api/tracked-routes/:id", async (c) => {
  const email = c.get("userEmail");
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);
  // A body that is not JSON is a bad request, not a crash: `c.req.json()` throws,
  // and an unhandled throw here is a bare 500. Same shape the login handler and
  // `POST /api/alerts/run` already use.
  const b = await c.req.json<RouteBody>().catch(() => null);
  if (!b) return c.json({ error: "bad_body" }, 400);

  const alerts = validateAlerts(b, c.env);
  if (!alerts.ok) return c.json({ error: alerts.error, message: alerts.message }, 400);

  const lists = validateLists(b);
  if (!lists.ok) return c.json({ error: "bad_list", message: lists.message }, 400);

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
  // Format as well as ordering. The ordering check was already here; the format
  // check was in neither handler, and ordering is meaningless on something that
  // is not a date — "zzz" and "yyy" compare perfectly well and store perfectly
  // well. Checked against the MERGED pair, so this also refuses to write a row
  // back whose stored half is already bad.
  if (!isIsoDate(dateStart) || !isIsoDate(dateEnd)) {
    return c.json(
      { error: "bad_window", message: "Give a start and end date as YYYY-MM-DD." },
      400,
    );
  }
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

  const roundTrip = b.roundTrip === undefined ? Number(row.round_trip ?? 0) : b.roundTrip ? 1 : 0;

  // Unlike the filters above, an ABSENT `via` does NOT simply keep the stored
  // one — it re-asks, but only when nothing is stored. That is what makes a
  // route created before hubs existed pick them up the first time it is edited,
  // while a route whose hubs somebody chose keeps them. An empty array still
  // means "no hubs", including as a way to say so permanently.
  const storedVia = storedList(row.via);
  const via =
    b.via === undefined
      ? storedVia.length
        ? storedVia
        : await autoVia(c.env.DB, spec, roundTrip === 1)
      : (b.via ?? []);

  await c.env.DB.prepare(
    `UPDATE tracked_routes
        SET origin = ?, destination = ?, origins = ?, destinations = ?, via = ?,
            date_start = ?, date_end = ?,
            cabin = ?, cabins = ?, currencies = ?, min_seats = ?, direct_only = ?,
            point_limit = ?,
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
      viaColumn(via),
      dateStart,
      dateEnd,
      // Representative value for any `SELECT *` reader; `cabins` is the filter.
      cabins ? (storedList(cabins).length === 1 ? storedList(cabins)[0] : "any") : "any",
      cabins,
      currencies,
      clampMinSeats(b.minSeats, clampMinSeats(row.min_seats, 1)),
      b.directOnly === undefined ? Number(row.direct_only ?? 0) : b.directOnly ? 1 : 0,
      // Absent keeps the stored ceiling; `null` (what the edit form sends for an
      // empty field) clears it.
      clampPointLimit(b.pointLimit, row.point_limit == null ? null : Number(row.point_limit)),
      roundTrip,
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

/**
 * What hubs the route graph would suggest for this route, right now.
 *
 * **A suggestion, and it writes nothing.** That is what makes it usable from the
 * edit dialog: the answer fills the Via field, the person looks at it, and Save
 * is what commits — so Cancel still cancels. An endpoint that wrote would make
 * "let me see what it thinks" an irreversible act.
 *
 * It exists because `autoVia`-on-create is a one-shot and the graph moves under a
 * route: fetch another program on the Tools page and a pair that reached nothing
 * yesterday may reach three hubs today. PATCH will not re-ask for a route that
 * already has hubs — its merge rules keep what somebody chose — so without this
 * there is no way to re-rank at all.
 *
 * Costs nothing. `autoVia` is D1 reads over the graph that is already stored.
 */
trackedRoutes.get("/api/tracked-routes/:id/paths", async (c) => {
  const email = c.get("userEmail");
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT origin, destination, origins, destinations, round_trip
       FROM tracked_routes WHERE id = ? AND user_email = ?`,
  )
    .bind(id, email)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  let spec: ReturnType<typeof normalizeSpec>;
  try {
    spec = normalizeSpec({
      origins: storedList(row.origins).length
        ? storedList(row.origins)
        : [String(row.origin)],
      destinations: storedList(row.destinations).length
        ? storedList(row.destinations)
        : [String(row.destination)],
    });
  } catch (err) {
    return c.json({ error: "bad_route_spec", message: (err as Error).message }, 400);
  }

  return c.json({ via: await autoVia(c.env.DB, spec, Number(row.round_trip ?? 0) === 1) });
});

trackedRoutes.delete("/api/tracked-routes/:id", async (c) => {
  const email = c.get("userEmail");
  // The one place the old `Number(...)` did real damage: `NaN` matched no row, so
  // this answered `{ ok: true }` for a route that never existed — a lie told with
  // a 200. See `rowIdParam`.
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);
  await c.env.DB.prepare("DELETE FROM tracked_routes WHERE id = ? AND user_email = ?")
    .bind(id, email)
    .run();
  return c.json({ ok: true });
});

