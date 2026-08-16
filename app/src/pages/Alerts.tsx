import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { api, type AlertScheduleRoute, type AlertTickResult } from "../api";
import { formatInterval } from "../alerts";
import { AlertStateChip, PagePad, sinceLabel } from "../ui";

/**
 * The Alerts tab.
 *
 * **This page is the feature's safety mechanism, not its dashboard.** The app
 * sends no email when a sweep fails — only when it finds something — so a
 * scheduler that is blocked, refused, or quietly failing produces exactly the
 * same silence as one that ran and found nothing. `wrangler.toml` used to
 * forbid cron on precisely that ground ("unattended work hides source
 * failures"), and this page is the answer: every sweep, every skip and every
 * dropped digest is on it, by name.
 *
 * So the ordering here is deliberate — problems first, cadence second, routes
 * third, history last. Anything that would make the mail stop is above the fold.
 *
 * **The manual controls are local dev only** and appear only when
 * `schedule.manualTick` says the endpoint exists (`POST /api/alerts/run` 404s in
 * production). They are the development loop for `alerts/` — waiting fifteen
 * minutes for a tick, then hours for it to pick your route, is not one. They
 * call the same `runAlertTick` the cron does, and the result panel prints the
 * whole `TickResult`, because a page whose entire job is making silent failure
 * visible must not grow a button that fails silently.
 *
 * It is a DOCUMENT, not a workbench, so it wraps itself in `PagePad` and owns
 * its own scrolling (see the `Layout` docblock in router.tsx).
 */
export function Alerts() {
  const qc = useQueryClient();
  const schedule = useQuery({ queryKey: ["alert-schedule"], queryFn: api.alertSchedule });
  const runs = useQuery({ queryKey: ["alert-runs"], queryFn: () => api.alertRuns(15) });
  const deliveries = useQuery({
    queryKey: ["alert-deliveries"],
    queryFn: () => api.alertDeliveries(15),
  });

  const tick = useMutation({
    mutationFn: (routeId?: number) => api.alertRunTick(routeId),
    onSuccess: () => {
      // A sweep ingests finds and spends calls, so it moves more than this page:
      // `alert-schedule` is also what the tab-strip health dot reads
      // (router.tsx), and the last two mirror what `useRouteSearch` invalidates
      // after a hand-pressed Search.
      for (const key of [
        ["alert-schedule"],
        ["alert-runs"],
        ["alert-deliveries"],
        ["dashboard"],
        ["quota"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });

  if (schedule.isLoading) return <PagePad>Loading…</PagePad>;
  if (schedule.error) {
    return (
      <PagePad>
        <Alert severity="error">{(schedule.error as Error).message}</Alert>
      </PagePad>
    );
  }
  const s = schedule.data!;
  const failing = s.routes.filter((r) => r.consecutiveFailures > 0);
  const expired = s.routes.filter((r) => r.windowExpired);
  const dropped = (deliveries.data ?? []).filter((d) => d.status !== "sent");

  return (
    <PagePad>
      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 0.5, alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography variant="h6">Alerts</Typography>
        {s.manualTick && (
          <Tooltip title="Run one tick exactly as the cron would — usually a no-op, because it only sweeps a route that is due.">
            <span>
              <Button
                size="small"
                variant="outlined"
                onClick={() => tick.mutate(undefined)}
                disabled={tick.isPending}
                startIcon={
                  tick.isPending ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    <PlayArrowRoundedIcon fontSize="small" />
                  )
                }
              >
                {tick.isPending ? "Running…" : "Run tick"}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Tracked routes marked for alerts are re-searched on a schedule and mailed
        to you when something changes
      </Typography>

      {s.manualTick && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>Local dev.</strong> The <em>Run tick</em> and <em>Sweep</em>{" "}
          buttons exist only under <code>wrangler dev</code> and call the same{" "}
          <code>runAlertTick</code> the cron does. They spend real seats.aero
          calls against today's allowance — the budget guard still refuses them,
          the pacing schedule does not.
        </Alert>
      )}
      {tick.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>The tick did not complete.</strong> {String(tick.error)}
        </Alert>
      )}
      {tick.data && !tick.isPending && <TickPanel result={tick.data} routes={s.routes} />}

      {/* ---- Problems, first ---- */}
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
          window, drop a route, or raise <code>ALERT_DAILY_BUDGET</code>.
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
      {dropped.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>{dropped.length} digest{dropped.length === 1 ? "" : "s"} not delivered.</strong>{" "}
          See the history below — a digest that was never sent leaves no other trace.
        </Alert>
      )}

      {/* ---- Cadence ---- */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" spacing={4} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Stat
            label="Cadence"
            value={
              s.pacing.intervalMinutes ? formatInterval(s.pacing.intervalMinutes) : "not running"
            }
            help="How often each route is re-searched. Derived from the daily budget divided by what these routes measurably cost — not a fixed setting."
          />
          <Stat
            label="Cost per pass"
            value={`${s.pacing.cycleCost} calls`}
            help="One sweep of every alert-enabled route."
          />
          <Stat
            label="Spent today"
            value={`${s.budget.selfSpentToday} / ${s.budget.dailyBudget}`}
            help="What automation has spent against its own daily allowance. Resets 00:00 UTC."
          />
          <Stat
            label="Allowance left"
            value={
              s.budget.observedRemaining == null
                ? `~${Math.max(0, 1000 - s.budget.selfSpentToday)}`
                : String(s.budget.observedRemaining)
            }
            help={
              s.budget.basis === "observed"
                ? "Read from seats.aero's own rate-limit header."
                : "Nothing has reported a number yet today, so this is counted from our own records instead. The first real observation corrects it."
            }
          />
          <Stat
            label="Reserve"
            value={`${s.budget.reserve} calls`}
            help="Never spent by the scheduler, so pressing Search by hand always works."
          />
        </Stack>
      </Paper>

      {/* ---- Routes ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Routes
      </Typography>
      {s.routes.length === 0 ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          No route has alerts on. Turn one on from a route's edit form on the
          Routes tab.
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ mb: 3, overflowX: "auto" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Route</TableCell>
                <TableCell>Tells you about</TableCell>
                <TableCell align="right">Cost</TableCell>
                <TableCell>Last swept</TableCell>
                <TableCell>Last emailed</TableCell>
                <TableCell>State</TableCell>
                {s.manualTick && <TableCell />}
              </TableRow>
            </TableHead>
            <TableBody>
              {s.routes.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
                      {r.alertOn.map((t) => (
                        <Chip key={t} size="small" variant="outlined" label={t.replace("_", " ")} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip
                      title={
                        r.observedCalls == null
                          ? "Never swept, so this is the worst case — the estimate is deliberately pessimistic until something is measured."
                          : "Measured from this route's last sweep."
                      }
                    >
                      <span>
                        {r.estimatedCalls}
                        {r.observedCalls == null ? "?" : ""}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{sinceLabel(r.lastAttemptAt)}</TableCell>
                  <TableCell>{sinceLabel(r.lastDigestAt)}</TableCell>
                  <TableCell>
                    <AlertStateChip route={r} />
                  </TableCell>
                  {s.manualTick && (
                    <TableCell align="right">
                      <Tooltip
                        title={
                          r.windowExpired
                            ? "The window has expired — there is nothing left to search."
                            : `Sweep now, due or not. Spends about ${r.estimatedCalls} calls.`
                        }
                      >
                        <span>
                          <Button
                            size="small"
                            onClick={() => tick.mutate(r.id)}
                            disabled={tick.isPending || r.windowExpired}
                          >
                            Sweep
                          </Button>
                        </span>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* ---- History ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Recent sweeps
      </Typography>
      <Paper variant="outlined" sx={{ mb: 3, overflowX: "auto" }}>
        {(runs.data ?? []).length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No sweep has run yet.
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Calls</TableCell>
                <TableCell align="right">Found</TableCell>
                <TableCell>Error</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(runs.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{sinceLabel(r.started_at)}</TableCell>
                  <TableCell>
                    {r.origin} → {r.destination}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={
                        r.status === "ok"
                          ? "success"
                          : r.status === "running"
                            ? "info"
                            : r.status === "partial"
                              ? "warning"
                              : "error"
                      }
                      label={r.status}
                    />
                  </TableCell>
                  <TableCell align="right">{r.calls ?? "—"}</TableCell>
                  <TableCell align="right">{r.offers_found}</TableCell>
                  <TableCell sx={{ maxWidth: 280, wordBreak: "break-word" }}>
                    {r.error ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Sent mail
      </Typography>
      <Paper variant="outlined" sx={{ overflowX: "auto" }}>
        {(deliveries.data ?? []).length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Nothing has been sent yet.
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>To</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell align="right">Changes</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(deliveries.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{sinceLabel(d.created_at)}</TableCell>
                  <TableCell>{d.to_email}</TableCell>
                  <TableCell>{d.subject}</TableCell>
                  <TableCell align="right">{d.change_count}</TableCell>
                  <TableCell>
                    <Tooltip title={d.error ?? ""}>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={
                          d.status === "sent" ? "success" : d.status === "failed" ? "error" : "warning"
                        }
                        label={d.status}
                      />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        The scheduler wakes every 15 minutes and sweeps at most one route, so a
        wide route can take a few wake-ups to finish. A digest goes out once a
        full pass is complete. See <code>docs/ALERTS.md</code>.
      </Typography>
    </PagePad>
  );
}

function Stat({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <Tooltip title={help}>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {label}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
      </Box>
    </Tooltip>
  );
}

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
function TickPanel({ result, routes }: { result: AlertTickResult; routes: AlertScheduleRoute[] }) {
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
