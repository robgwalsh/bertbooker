// The words the route form and header use for alerts.
//
// `ALERT_TYPES` is here rather than in `shared/` and its ORDER is the reason:
// `ALL_ALERT_TYPES` in `api/src/features/alerts/select.ts` lists the same four
// members with `more_seats` and `price_drop` the other way round, and this is
// the order the checkboxes below render in. The TYPE is shared; adopting the
// shared array would silently reorder a form.

import { ALERT_HEALTH, alertHealth, formatInterval } from "../../lib/alerts";
import { sinceLabel } from "../../lib/format";
import { parseAlertOn } from "./form";
import type { AlertScheduleRoute, AlertType, TrackedRoute } from "../../api";

export { ALERT_TYPES } from "../../lib/alerts";

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  new: "New space",
  price_drop: "Cheaper",
  more_seats: "More seats",
  gone: "Gone",
};

/**
 * What each transition actually means, because two of them are easy to misread.
 *
 * `more_seats` carries the first-match-wins caveat: `diffAvailability` checks
 * seats before price, so a drop that coincides with a seat increase is
 * classified `more_seats` and a route watching only `price_drop` never hears
 * about it. Documented here rather than fixed, because changing the classifier
 * would change `changes_json` for the alert sweep too — pinned by a test in
 * api/src/features/alerts/select.test.ts.
 */
export const ALERT_TYPE_HELP: Record<AlertType, string> = {
  new: "Award space that wasn't there before",
  price_drop: "The same seat got cheaper",
  more_seats: "Seat count rose — also covers a drop that came with extra seats",
  gone: "Space that disappeared. Often just cache churn",
};

/** What an alert route watches, for the header's chip: `New space · Cheaper`.
 *  Read off the STORED column, not off the schedule — the schedule only lists
 *  routes that are enrolled, and it can still be in flight. */
export function alertOnLabel(route: TrackedRoute): string {
  return parseAlertOn(route.alert_on)
    .map((t) => ALERT_TYPE_LABEL[t])
    .join(" · ");
}

export const ALERTS_OFF_HELP =
  "This route is not enrolled in the scheduled sweep. Turn alerts on and it is re-searched on a cadence and emails you when something changes — the one setting here that spends metered calls with nobody watching.";

/**
 * The alerts chip's tooltip: what fires, where it goes, and how it is doing.
 *
 * The health sentence and the cadence come from `AlertSchedule`, which is why
 * both are conditional — the shell's poll may not have landed, and a route
 * whose alerts were just turned on has no row there until it refetches. What
 * the route is CONFIGURED to do is always available, so that half never blinks.
 */
export function alertHelp(
  route: TrackedRoute,
  alert: AlertScheduleRoute | undefined,
  intervalMinutes: number | null | undefined,
): string {
  const watching = parseAlertOn(route.alert_on)
    .map((t) => ALERT_TYPE_LABEL[t].toLowerCase())
    .join(", ");
  const drop = route.alert_min_drop_pct
    ? `Price drops under ${route.alert_min_drop_pct}% are ignored.`
    : "Any price drop counts.";
  const to = `Sent to ${route.alert_email || "the account address"}.`;
  const last = `Last emailed ${sinceLabel(route.alert_last_digest_at)}.`;
  const cadence = intervalMinutes ? ` Swept ${formatInterval(intervalMinutes)}.` : "";
  const state = alert ? ` ${ALERT_HEALTH[alertHealth(alert)].help}` : "";
  return `Emails you about ${watching}. ${drop} ${to} ${last}${cadence}${state}`;
}

