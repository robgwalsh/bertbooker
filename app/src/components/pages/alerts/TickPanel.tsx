import Alert from "@mui/material/Alert";
import type { AlertScheduleRoute, AlertTickResult } from "../../../api";

/** Why a skipped route was skipped, in words. Falls through to the raw code
 *  rather than swallowing an unrecognised one — a reason this page cannot name
 *  is still a reason it must show. */
const SKIP_REASONS: Record<string, string> = {
  reserve: "the budget guard refused it — a sweep would eat into the reserve that keeps a manual Search working",
  exhausted: "the day's seats.aero allowance is spent",
  not_alert_route: "no such alert-enabled route",
  window_expired: "its date window has fallen entirely into the past",
};

/**
 * What one hand-fired tick did.
 *
 * Every field of `TickResult`, never an "ok". The whole feature is built around
 * the fact that a sweep which found nothing and a sweep which never ran look
 * identical from the outside — a manual trigger that reported success and left
 * you to guess would rebuild that problem on the one page meant to solve it.
 * So: no route swept and none skipped is a *warning*, and it says why.
 */
export function TickPanel({
  result,
  routes,
}: {
  result: AlertTickResult;
  routes: AlertScheduleRoute[];
}) {
  const label = (id: number) => routes.find((r) => r.id === id)?.label ?? `route ${id}`;
  const idle = result.sweptRouteIds.length === 0 && result.skipped.length === 0;
  return (
    <Alert severity={idle ? "warning" : "success"} sx={{ mb: 2 }}>
      {result.sweptRouteIds.length > 0 && (
        <div>
          <strong>Swept {result.sweptRouteIds.map(label).join(", ")}.</strong> Its
          run is in Recent sweeps below.
        </div>
      )}
      {result.skipped.map((sk) => (
        <div key={`${sk.routeId}:${sk.reason}`}>
          <strong>Skipped {label(sk.routeId)}</strong> — {SKIP_REASONS[sk.reason] ?? sk.reason}.
        </div>
      ))}
      {idle && (
        <div>
          <strong>The tick swept nothing.</strong>{" "}
          {result.pacing.startsWith("every ")
            ? "No route was due yet. Use a route's Sweep button to force one."
            : "There is no cadence at all — see the banners above."}
        </div>
      )}
      <div>
        Cadence: <code>{result.pacing}</code>
        {result.flushed > 0
          ? ` · ${result.flushed} digest${result.flushed === 1 ? "" : "s"} sent — see Sent mail below.`
          : " · no digest sent (the cycle is not complete, or there was nothing to send)."}
      </div>
    </Alert>
  );
}
