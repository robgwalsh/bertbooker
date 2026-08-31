import { Box } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * A dot on the Alerts tab when the scheduler is in trouble.
 *
 * This is small and it is load-bearing. A failed sweep sends NO email — only
 * finds do — so a scheduler that has been blocked all week produces exactly the
 * same silence as one that ran and found nothing. Without a signal in the shell
 * you would only discover it by opening a tab you have no reason to open.
 *
 * Renders nothing when there is nothing wrong, and never blocks the bar: a
 * failed query is not itself an alarm.
 */
export function AlertsHealthDot() {
  const { data } = useQuery({
    queryKey: ["alert-schedule"],
    queryFn: api.alertSchedule,
    // The cron wakes every 30 minutes; polling faster than that learns nothing.
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  if (!data) return null;
  const unhealthy =
    data.routes.some((r) => r.consecutiveFailures > 0 || r.windowExpired) ||
    (data.routes.length > 0 && !data.pacing.affordable) ||
    (data.routes.length > 0 && !data.email.configured) ||
    Boolean(data.budget.blockedReason);
  if (!unhealthy) return null;
  return (
    <Box
      component="span"
      aria-label="Alerts need attention"
      sx={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        ml: 0.75,
        verticalAlign: "middle",
        bgcolor: "warning.main",
      }}
    />
  );
}
