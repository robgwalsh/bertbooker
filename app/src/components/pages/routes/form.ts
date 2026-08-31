// The route form as DATA: what a person is choosing, how it is seeded, and
// when it is not yet submittable. No JSX — `RouteFormFields` renders it.
//
// This shape is the route's GATHERING spec — the settings that decide what the
// Worker asks seats.aero for, and which therefore need a search behind them.
// The read filters (cabins, cards, seats, nonstop, point limit) are not here:
// they cost nothing, reverse instantly, and are edited where they are stated,
// in the header's chip strip. Cabins is the one that also appears on this form,
// as a prop rather than a field — a route being created has no header yet.

import { ALERT_TYPES } from "../../../lib/alerts";
import { parseCodeList, parseCodes } from "../../../lib/routeShape";
import { defaultRouteWindow } from "../../../lib/routeWindow";
import type { AlertType, TrackedRoute } from "../../../api";

/**
 * The route form's state — one shape for creating and for editing.
 *
 * Deliberately not `TrackedRoute`: that is the stored row, with JSON-string
 * columns and legacy scalars beside the arrays that supersede them. This is what
 * a person is choosing, and `formFromRoute` is the one place the two meet.
 */
export interface RouteForm {
  origins: string[];
  destinations: string[];
  /** Hubs to route through. A GATHERING setting like roundTrip — it plans a
   *  second seats.aero query per date range — and unavailable on a round trip. */
  via: string[];
  dateStart: string;
  dateEnd: string;
  /** Watch both directions. One of the two fields on this form that change what
   *  is GATHERED rather than what is shown. */
  roundTrip: boolean;
  /** The other one: enroll this route in the cron sweep. See docs/ALERTS.md. */
  alertsEnabled: boolean;
  /** Empty = the account's own address. */
  alertEmail: string;
  /** Which transitions email. Never empty while alerts are on — the API refuses
   *  it, because "armed and permanently silent" looks exactly like broken. */
  alertOn: AlertType[];
  alertMinDropPct: number;
}

/**
 * One field of the route form, by name — what the header's values point at.
 *
 * The keys are `RouteForm`'s own, so a field renamed there fails to compile here
 * rather than quietly pointing at nothing. It also means a READ FILTER cannot be
 * named: those are not fields of this form, so the header physically cannot
 * route one into the dialog, and the split is enforced by the compiler rather
 * than by everyone remembering it.
 */
export type RouteField = keyof RouteForm;

/** The route the edit dialog is open on, and which of its fields to land on. */
export interface EditTarget {
  route: TrackedRoute;
  /** Absent when the dialog was opened from the Edit button — no field is
   *  more relevant than any other there, so nothing is focused and MUI's own
   *  initial focus applies. */
  focus?: RouteField;
}

export function defaultRouteForm(): RouteForm {
  return {
    // Airport SETS, not scalars: one route can watch SEA/PDX -> NRT/HND, because
    // seats.aero takes comma-delimited airports and covers the whole cross
    // product in one call.
    origins: [] as string[],
    destinations: [] as string[],
    // Filled in by the WORKER when this route is saved and its pair reaches
    // nothing directly, which is why the form starts empty rather than guessing.
    via: [] as string[],
    // Shared with the Tools page's "Track these legs", which creates routes too.
    ...defaultRouteWindow(),
    roundTrip: false,
    // Off by default: it is the one setting here that spends metered calls
    // without anyone pressing anything.
    alertsEnabled: false,
    alertEmail: "",
    alertOn: ["new", "price_drop"],
    alertMinDropPct: 5,
  };
}

/** A stored route back into the form that edits it. */
export function formFromRoute(r: TrackedRoute): RouteForm {
  return {
    origins: parseCodes(r.origins, r.origin),
    destinations: parseCodes(r.destinations, r.destination),
    via: parseCodeList(r.via),
    dateStart: r.date_start,
    dateEnd: r.date_end,
    roundTrip: Boolean(r.round_trip),
    alertsEnabled: Boolean(r.alerts_enabled),
    alertEmail: r.alert_email ?? "",
    // NULL means the default set, which is what the form must show — an empty
    // multi-select would read as "nothing selected" for a route that in fact
    // alerts on the defaults.
    alertOn: parseAlertOn(r.alert_on),
    alertMinDropPct: r.alert_min_drop_pct ?? 5,
  };
}

/** A stored `alert_on` back into the form's list. Mirrors `parseAlertTypes` in
 *  api/src/features/alerts/select.ts — NULL and anything unrecognised mean the
 *  default set, never "nothing". */
export function parseAlertOn(json: string | null): AlertType[] {
  if (!json) return ["new", "price_drop"];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return ["new", "price_drop"];
    const kept = parsed.filter((t): t is AlertType =>
      (ALERT_TYPES as readonly string[]).includes(String(t)),
    );
    return kept.length ? kept : ["new", "price_drop"];
  } catch {
    return ["new", "price_drop"];
  }
}

/**
 * What someone typed into a points ceiling, as the wire means it.
 *
 * EMPTY is the unset value and the only one: 0 and negatives collapse to `null`
 * here and are refused by the Worker, because a route that hides every find it
 * has looks exactly like a broken one. Mirrors `clampPointLimit` in
 * api/src/features/trackedRoutes/endpoints.ts — a divergence between the two reads as a
 * filter silently hiding everything.
 */
export function parsePointLimit(raw: string): number | null {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  return trimmed === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n);
}

/**
 * The form as a CREATE body.
 *
 * One line of difference from the form itself, and it is load-bearing: `via` is
 * **omitted** rather than sent empty when the field was left alone. The Worker
 * reads an absent `via` as "work it out from the route graph" and an empty array
 * as "no hubs, I mean it" — three-valued on purpose — and this form always HAS
 * the field. Posting it wholesale therefore said "no hubs" on every new route
 * and `autoVia` never ran once, which is precisely the bug that made a
 * freshly-created SFO→KTM sit there saying it had found nothing.
 *
 * A user who deliberately empties Via in the ADD dialog still gets hubs, and
 * that is the right way round: creating a route is the one moment nobody has an
 * opinion yet, and the hubs land in the header where one edit removes them.
 * Editing is different — see `EditRouteDialog`, which sends `via` always, so
 * clearing the field there really does clear it.
 *
 * Cabins is not here: the Add dialog holds it beside the form and merges it in,
 * because it is a read filter the header owns everywhere else.
 *
 * Pure and in `form.ts` rather than inline in the dialog so a test can reach it:
 * this is a wire contract expressed in one `?:`, which is exactly the kind that
 * breaks in silence.
 */
export function createRouteBody(form: RouteForm): Omit<RouteForm, "via"> & { via?: string[] } {
  if (form.via.length) return form;
  const { via: _dropped, ...rest } = form;
  return rest;
}

/** A route the form cannot yet submit. Shared, so the Add dialog and the edit
 *  dialog cannot disagree about what a complete route is. */
export function routeFormIncomplete(form: RouteForm): boolean {
  return (
    form.origins.length === 0 ||
    form.destinations.length === 0 ||
    form.dateEnd < form.dateStart ||
    // The API refuses this with a 400, and rightly: a route with alerts on and
    // no transitions chosen is armed and permanently silent, which reads exactly
    // like a broken feature. Catch it here so the button is disabled rather than
    // the save failing.
    (form.alertsEnabled && form.alertOn.length === 0)
  );
}
