// The route form as DATA: what a person is choosing, how it is seeded, and
// when it is not yet submittable. No JSX — `RouteFormFields` renders it.
//
// One shape for creating and for editing, which is the point: a setting
// expressible on only one of those surfaces is either a choice you make once
// and can never revise, or a revision you can never make. Both have happened
// here.

import { ALERT_TYPES } from "../../lib/alerts";
import { parseCodeList, parseCodes } from "../../lib/routeShape";
import { isoDate } from "./dates";
import type { AlertType, TrackedRoute } from "../../api";

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
  dateStart: string;
  dateEnd: string;
  cabins: string[];
  currencies: string[];
  minSeats: number;
  directOnly: boolean;
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
 * Every value in the header IS a field of this form, so reading the header and
 * then hunting for the matching control in a dialog of thirteen is a step the
 * app can just take for you. The keys are `RouteForm`'s own, so a field renamed
 * there fails to compile here rather than quietly pointing at nothing.
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
  const start = new Date();
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1);
  return {
    // Airport SETS, not scalars: one route can watch SEA/PDX -> NRT/HND, because
    // seats.aero takes comma-delimited airports and covers the whole cross
    // product in one call.
    origins: [] as string[],
    destinations: [] as string[],
    dateStart: isoDate(start),
    dateEnd: isoDate(end),
    // Empty = every cabin. The default USED to be business-only, which quietly
    // hid economy space the route had already paid to find: gathering is wide
    // and unfiltered, so a cabin filter here only decides what you are shown.
    // Narrowing is one click; noticing that you never saw it is not.
    cabins: [] as string[],
    currencies: [] as string[], // empty = any card the couple holds
    minSeats: 2,
    directOnly: false,
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
    dateStart: r.date_start,
    dateEnd: r.date_end,
    cabins: parseCodeList(r.cabins),
    currencies: parseCodeList(r.currencies),
    minSeats: r.min_seats ?? 2,
    directOnly: Boolean(r.direct_only),
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
 *  shared/src/alerts/select.ts — NULL and anything unrecognised mean the
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
