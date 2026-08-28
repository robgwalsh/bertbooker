import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { api, type Find } from "../../api";
import { PriceHistoryChart } from "./PriceHistoryChart";
import { priceSeries } from "../../lib/priceHistory";
import { CabinChip } from "../../components/brand";
import { dayLabel, miles, sinceLabel } from "../../lib/format";

// The whole series for one slot, on a click.
//
// `enabled: open` is what keeps this a click rather than a fetch per row: a wide
// route holds a thousand finds, and a query mounted with the row would ask about
// every one of them. The response is free — `price_history` is ours and reaches
// no vendor — but a thousand requests is still a thousand requests.

export function PriceHistoryDialog({
  find,
  open,
  onClose,
}: {
  find: Find;
  open: boolean;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: [
      "findHistory",
      find.origin,
      find.destination,
      find.flight_date,
      find.program,
      find.cabin,
    ],
    queryFn: () =>
      api.findHistory({
        origin: find.origin,
        destination: find.destination,
        flightDate: find.flight_date,
        program: find.program,
        cabin: find.cabin,
      }),
    enabled: open,
  });

  const series = q.data ? priceSeries(q.data.points) : [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="h6" component="span">
            {find.origin} → {find.destination}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {dayLabel(find.flight_date)} · {find.program}
          </Typography>
          <CabinChip cabin={find.cabin} />
        </Stack>
      </DialogTitle>
      <DialogContent>
        {q.isPending && <CircularProgress size={20} />}
        {q.isError && (
          <Alert severity="error">
            {q.error instanceof Error ? q.error.message : "Could not read the history"}
          </Alert>
        )}
        {q.data && series.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No history yet. This slot has been seen once, and a second look is what
            makes a line.
          </Typography>
        )}
        {q.data && series.length > 0 && (
          <Stack spacing={1.5}>
            <PriceHistoryChart series={series} />
            {/* Points are written ON CHANGE, so this count is how many times the
                price or the seat count actually moved — not how many times
                anybody searched. Saying "observations" would claim the second. */}
            <Typography variant="caption" color="text.secondary">
              {series.length} change{series.length === 1 ? "" : "s"} recorded, first seen{" "}
              {sinceLabel(series[0]!.at)}
              {find.best_miles_ever != null && ` · cheapest ever ${miles(find.best_miles_ever)}`}
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
