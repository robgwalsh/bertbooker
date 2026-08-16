import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import { AlertStateChip } from "../../components/AlertStateChip";
import { sinceLabel } from "../../lib/format";
import type { AlertSchedule } from "../../api";

/**
 * Every alert-enabled route, and what the scheduler thinks of it.
 *
 * The Sweep button in the last column is **local dev only** — it appears with
 * `schedule.manualTick`, which is false in production because
 * `POST /api/alerts/run` 404s there.
 */
export function AlertRoutesTable({
  schedule: s,
  onSweep,
  sweeping,
}: {
  schedule: AlertSchedule;
  onSweep: (routeId: number) => void;
  sweeping: boolean;
}) {
  if (s.routes.length === 0) {
    return (
      <Alert severity="info" sx={{ mb: 3 }}>
        No route has alerts on. Turn one on from a route's edit form on the
        Routes tab.
      </Alert>
    );
  }
  return (
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
                        onClick={() => onSweep(r.id)}
                        disabled={sweeping || r.windowExpired}
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
  );
}
