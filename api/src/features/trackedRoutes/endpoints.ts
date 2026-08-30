import { Hono } from "hono";
import { baselineOnEnable } from "../alerts/pace.js";
import { normalizeSpec } from "../../domain/routing.js";
import { isIsoDate } from "../../domain/window.js";
import { rowIdParam } from "../../http/params.js";
import { autoVia } from "./autoVia.js";
import {
  clampDropPct,
  clampMinSeats,
  clampPointLimit,
  storedList,
  validateAlerts,
  validateLists,
  viaColumn,
  type RouteBody,
} from "./routeBody.js";
import {
  deleteTrackedRoute,
  insertTrackedRoute,
  selectAllTrackedRoutes,
  selectRouteShape,
  selectTrackedRouteRow,
  updateTrackedRoute,
} from "../../db/trackedRoutes.js";
import type { Env, Vars } from "../../bindings.js";

/**
 * Tracked routes — the saved searches everything else in the app hangs off.
 *
 * The two writers here are the Add dialog and the header's edit mode, and they
 * are deliberately asymmetric: `POST` requires the date window, while `PATCH`
 * treats every field as optional and merges against the stored row. What the
 * Worker accepts, and every clamp and check on the way to a stored value, is
 * `./routeBody.ts` — including the three ways it differs from the SPA's
 * `RouteInput` and the assertion that keeps the two in step. What is left here
 * is the merge and the write.
 *
 * `POST /api/tracked-routes/:id/search` and `/enrich` are NOT here — they are
 * the search and enrich slices, mounted before this module so their more
 * specific paths are matched first.
 */
export const trackedRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- Tracked routes (saved searches) ----
trackedRoutes.get("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  return c.json(await selectAllTrackedRoutes(c.env.DB));
});

trackedRoutes.post("/api/tracked-routes", async (c) => {
  const email = c.get("userEmail");
  const b = await c.req
    .json<RouteBody & { dateStart: string; dateEnd: string }>()
    .catch(() => null);
  if (!b) return c.json({ error: "bad_body" }, 400);
  const cabins = b.cabins?.length ? b.cabins : null;

  const alerts = await validateAlerts(b, c.env);
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

  const id = await insertTrackedRoute(c.env.DB, {
    // The scalars are NOT NULL and stay the route's PRIMARY airport of each
    // side. `runs` records them the same way, so a run can be read back against
    // the route it was of.
    origin: spec.origins[0]!,
    destination: spec.destinations[0]!,
    origins: JSON.stringify(spec.origins),
    destinations: JSON.stringify(spec.destinations),
    via: viaColumn(via),
    dateStart: b.dateStart,
    dateEnd: b.dateEnd,
    // Store NULL (not "[]") when no filter, so downstream "no filter" checks
    // treat an empty selection as "any cabin".
    cabins: cabins ? JSON.stringify(cabins) : null,
    minSeats: clampMinSeats(b.minSeats, 2),
    // Same NULL-when-empty rule for the currency filter ("any currency").
    currencies: b.currencies?.length ? JSON.stringify(b.currencies) : null,
    directOnly: b.directOnly ? 1 : 0,
    // NULL = no limit, which is what a route with no opinion gets.
    pointLimit: clampPointLimit(b.pointLimit, null),
    roundTrip: b.roundTrip ? 1 : 0,
    alertsEnabled: b.alertsEnabled ? 1 : 0,
    alertEmail: b.alertEmail?.trim() || null,
    // NULL means the default set. `[]` was already refused above.
    alertOn: b.alertOn?.length ? JSON.stringify(b.alertOn) : null,
    alertMinDropPct: clampDropPct(b.alertMinDropPct, 5),
  });
  return c.json({ id }, 201);
});

/**
 * Edit a stored route — the edit dialog, the header's filter chips, and no other
 * writer besides the Add dialog.
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

  const alerts = await validateAlerts(b, c.env);
  if (!alerts.ok) return c.json({ error: alerts.error, message: alerts.message }, 400);

  const lists = validateLists(b);
  if (!lists.ok) return c.json({ error: "bad_list", message: lists.message }, 400);

  const row = await selectTrackedRouteRow(c.env.DB, id);
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

  await updateTrackedRoute(c.env.DB, id, {
    // The scalars stay the PRIMARY airport of each side, exactly as on insert:
    // they are NOT NULL and `runs` records them the same way.
    origin: spec.origins[0]!,
    destination: spec.destinations[0]!,
    origins: JSON.stringify(spec.origins),
    destinations: JSON.stringify(spec.destinations),
    via: viaColumn(via),
    dateStart,
    dateEnd,
    // Representative value for any `SELECT *` reader; `cabins` is the filter.
    cabin: cabins ? (storedList(cabins).length === 1 ? storedList(cabins)[0]! : "any") : "any",
    cabins,
    currencies,
    minSeats: clampMinSeats(b.minSeats, clampMinSeats(row.min_seats, 1)),
    directOnly: b.directOnly === undefined ? Number(row.direct_only ?? 0) : b.directOnly ? 1 : 0,
    // Absent keeps the stored ceiling; `null` (what the header's chip sends
    // for an empty field, or for "No limit") clears it.
    pointLimit: clampPointLimit(
      b.pointLimit,
      row.point_limit == null ? null : Number(row.point_limit),
    ),
    roundTrip,
    alertsEnabled,
    alertEmail:
      b.alertEmail === undefined
        ? (row.alert_email as string | null)
        : b.alertEmail?.trim() || null,
    // `undefined` keeps what is stored; `null` resets to the default set. `[]`
    // was refused above rather than stored as "never fire".
    alertOn:
      b.alertOn === undefined
        ? (row.alert_on as string | null)
        : b.alertOn?.length
          ? JSON.stringify(b.alertOn)
          : null,
    alertMinDropPct: clampDropPct(b.alertMinDropPct, Number(row.alert_min_drop_pct ?? 5)),
    // Only consulted by the CASE inside the statement, i.e. only on an
    // OFF -> ON transition.
    baselineDigestAt: baselineOnEnable(
      row.last_checked_at == null ? null : Number(row.last_checked_at),
      Date.now(),
    ),
  });

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
  const row = await selectRouteShape(c.env.DB, id);
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
  await deleteTrackedRoute(c.env.DB, id);
  return c.json({ ok: true });
});

