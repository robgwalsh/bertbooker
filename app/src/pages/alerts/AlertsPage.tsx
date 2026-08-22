import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { api } from "../../api";
import { PagePad } from "../../components/PagePad";
import { AlertRoutesTable } from "./AlertRoutesTable";
import { CadencePanel } from "./CadencePanel";
import { DeliveriesTable } from "./DeliveriesTable";
import { ProblemBanners } from "./ProblemBanners";
import { SweepHistory } from "./SweepHistory";
import { TickPanel } from "./TickPanel";

/**
 * The Alerts tab.
 *
 * **This page is the feature's safety mechanism, not its status board.** The app
 * sends no email when a sweep fails — only when it finds something — so a
 * scheduler that is blocked, refused, or quietly failing produces exactly the
 * same silence as one that ran and found nothing. This page is the answer:
 * every sweep, every skip and every dropped digest is on it, by name.
 *
 * **So the ordering here is deliberate — problems first, cadence second, routes
 * third, history last.** Anything that would make the mail stop is above the
 * fold, and that ordering is why this file is a composition of six named
 * sections rather than one long body: the sequence is the design, and it should
 * be legible in one screen of code.
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
        ["routes"],
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
      <ProblemBanners schedule={s} deliveries={deliveries.data ?? []} />

      {/* ---- Cadence ---- */}
      <CadencePanel schedule={s} />

      {/* ---- Routes ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Routes
      </Typography>
      <AlertRoutesTable
        schedule={s}
        onSweep={(routeId) => tick.mutate(routeId)}
        sweeping={tick.isPending}
      />

      {/* ---- History ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Recent sweeps
      </Typography>
      <SweepHistory runs={runs.data ?? []} />

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Sent mail
      </Typography>
      <DeliveriesTable deliveries={deliveries.data ?? []} />

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        The scheduler wakes every 15 minutes and sweeps at most one route, so a
        wide route can take a few wake-ups to finish. A digest goes out once a
        full pass is complete. See <code>docs/ALERTS.md</code>.
      </Typography>
    </PagePad>
  );
}
