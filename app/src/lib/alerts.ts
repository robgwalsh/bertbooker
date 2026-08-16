// How the SPA reads a route's alerting, in one place and with no JSX — so the
// three surfaces that now draw it (the Alerts tab's table, the Routes rail's
// bell, the selected route's header) cannot disagree, and so the ladder itself
// is testable under the web workspace's Node vitest. Same reason
// `preferences.ts` keeps its parser separate from the component that reads it.
//
// **Nothing here derives cadence or due-ness.** `docs/ALERTS.md` §4 is explicit
// that a page quoting a schedule the scheduler does not keep is worse than a
// page with no schedule on it, so `due`, `windowExpired` and `intervalMinutes`
// all arrive already decided in `AlertSchedule` — this module only names and
// orders what the server said.

import type { AlertScheduleRoute, AlertType } from "../api";

/**
 * The four transitions, IN THE ORDER THE ROUTE FORM DRAWS THEM.
 *
 * Deliberately app-local rather than taken from `ALL_ALERT_TYPES` in
 * `api/src/alerts/select.ts`, which lists the same four members with
 * `more_seats` and `price_drop` the other way round. The type is shared (it is
 * `ChangeType`); only this ORDER is the SPA's, because it is what the alert
 * checkboxes render in — adopting the shared array would silently reorder a
 * form for no reason.
 */
export const ALERT_TYPES: readonly AlertType[] = ["new", "price_drop", "more_seats", "gone"];

/**
 * The one question a person asks about an alert route: is it working, and if
 * not, is that a fault or just how it is meant to look right now.
 *
 * ORDERED, and the order is the point — the ladder is first-match-wins from the
 * most wrong to the most ordinary. A failing route whose window has also expired
 * is reported as `expired`, because that is the one you can actually fix.
 */
export type AlertHealth = "expired" | "failing" | "baseline" | "due" | "watching";

export function alertHealth(route: AlertScheduleRoute): AlertHealth {
  if (route.windowExpired) return "expired";
  if (route.consecutiveFailures > 0) return "failing";
  if (route.awaitingBaseline) return "baseline";
  if (route.due) return "due";
  return "watching";
}

/**
 * What each state is called, what colour it is, and what it means in words.
 *
 * `chipColor` is a MUI palette name for the outlined chips the Alerts tab and
 * the route header draw. `iconColor` is an `sx` colour for the rail's bell, and
 * it is deliberately NOT the same — the bell is 14px of silhouette with no label
 * beside it, so it gets two states rather than five: **yellow means armed, red
 * means broken.** Anything finer is unreadable at that size, and the tooltip
 * carries the detail. Yellow rather than green for the healthy case because the
 * rail's find count is already green, and a green bell beside it reads as a
 * second count; `warning.main` is the palette's own amber in all 21 themes.
 */
export const ALERT_HEALTH: Record<
  AlertHealth,
  { label: string; chipColor: "default" | "info" | "success" | "warning" | "error"; iconColor: string; help: string }
> = {
  expired: {
    label: "window expired",
    chipColor: "warning",
    // Broken, not merely idle: there is nothing left to search, so no sweep can
    // succeed until the window moves.
    iconColor: "error.main",
    help: "This route's dates have all fallen into the past, so there is nothing left to search. Move the window to start it again.",
  },
  failing: {
    label: "failing",
    chipColor: "error",
    iconColor: "error.main",
    help: "Recent sweeps have failed. Each retry waits twice as long as the last, and no email is ever sent about this — the Alerts tab is where it is explained.",
  },
  baseline: {
    label: "baseline pending",
    chipColor: "default",
    iconColor: "warning.main",
    help: "The next sweep establishes a baseline and sends nothing. Without it the first diff would call every find 'new' and mail you thousands.",
  },
  due: {
    label: "due",
    chipColor: "info",
    iconColor: "warning.main",
    help: "Due to be swept — the next tick that can afford it will pick this route up.",
  },
  watching: {
    label: "watching",
    chipColor: "success",
    iconColor: "warning.main",
    help: "Re-searched on a schedule. You are emailed when something changes.",
  },
};

/** A pacing interval in words. The number comes from `sweepPacing` on the
 *  server; this only formats it. */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `every ${h % 1 === 0 ? h : h.toFixed(1)} h`;
}
