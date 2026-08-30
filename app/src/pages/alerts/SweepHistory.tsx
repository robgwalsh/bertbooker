import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { sinceLabel } from "../../lib/format";
import type { Run } from "../../api";

/** Sweep runs — ordinary `runs` rows with `trigger='alert'`, so a sweep's
 *  failure is durable on its own row whether or not anything mailed about it.
 *  The Error column is the point of the table. */
export function SweepHistory({ runs }: { runs: Run[] }) {
  return (
    <Paper variant="outlined" sx={{ mb: 3, overflowX: "auto" }}>
      {runs.length === 0 ? (
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
            {runs.map((r) => (
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
  );
}
