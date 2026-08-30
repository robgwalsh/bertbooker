import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { sinceLabel } from "../../lib/format";
import type { AlertDelivery } from "../../api";

/** Every digest the app tried to send, including the ones that never went out.
 *  With no failure email anywhere in this feature, a `failed` or `skipped` row
 *  here is the only trace a dropped digest leaves. */
export function DeliveriesTable({ deliveries }: { deliveries: AlertDelivery[] }) {
  return (
    <Paper variant="outlined" sx={{ overflowX: "auto" }}>
      {deliveries.length === 0 ? (
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
            {deliveries.map((d) => (
              <TableRow key={`${d.sweep_id}-${d.to_email}`}>
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
  );
}
