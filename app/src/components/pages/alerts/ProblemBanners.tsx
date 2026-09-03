import Alert from "@mui/material/Alert";
import type { AlertSchedule } from "../../../api";

/**
 * Everything that would make the mail stop, above the fold.
 *
 * These are FIRST on the page and that is the page's whole argument: no email
 * is sent when a sweep breaks, only when it finds something, so a blocked or
 * failing scheduler is indistinguishable from a quiet one unless something says
 * so here. Each banner names the specific thing to change.
 *
 * Renders nothing when nothing is wrong — which is the common case, and is why
 * the cadence panel below it is not buried.
 */
export function ProblemBanners({ schedule: s }: { schedule: AlertSchedule }) {
  const failing = s.routes.filter((r) => r.consecutiveFailures > 0);
  const expired = s.routes.filter((r) => r.windowExpired);

  return (
    <>
      {!s.email.configured && s.routes.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>No email will be sent.</strong> Sweeps still run and still fill
          the database, but {s.email.from ? "RESEND_API_KEY" : "ALERT_FROM and RESEND_API_KEY"}{" "}
          {s.email.from ? "is" : "are"} unset, so every digest is recorded as
          skipped below rather than delivered.
        </Alert>
      )}
      {!s.pacing.affordable && s.pacing.reason === "cycle_exceeds_budget" && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>These routes cost more than a day's allowance.</strong> One pass
          over them is about {s.pacing.cycleCost} calls against a daily budget of{" "}
          {s.budget.dailyBudget}, so nothing is being swept at all. Narrow a date
          window, drop a route, or raise the allowance below.
        </Alert>
      )}
      {s.budget.blockedReason && s.pacing.affordable && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Sweeps are paused: {s.budget.blockedReason === "reserve"
            ? `a pass would leave less than the ${s.budget.reserve}-call reserve that keeps a manual Search working.`
            : "the day's seats.aero allowance is spent."}{" "}
          This clears at 00:00 UTC.
        </Alert>
      )}
      {failing.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>
            {failing.length} route{failing.length === 1 ? "" : "s"} failing.
          </strong>{" "}
          {failing.map((r) => r.label).join(", ")} — each retry waits twice as long
          as the last, so this will not fix itself.
        </Alert>
      )}
      {expired.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>Window expired:</strong> {expired.map((r) => r.label).join(", ")}.
          The date range has fallen entirely into the past, so there is nothing
          left to search. Move the window or turn alerts off.
        </Alert>
      )}
    </>
  );
}
