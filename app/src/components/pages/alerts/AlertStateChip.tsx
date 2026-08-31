import { Chip, Tooltip } from "@mui/material";
import { ALERT_HEALTH, alertHealth } from "../../../lib/alerts";
import type { AlertScheduleRoute } from "../../../api";

/**
 * A route's alert state as a chip. Lives here rather than on the Alerts tab
 * because three surfaces draw it now — that tab's table, and the Routes page's
 * header — and a second copy is a second opinion about what "failing" means.
 *
 * The words, the colour and the ladder behind them are all `lib/alerts.ts`; this
 * is only the chip.
 */
export function AlertStateChip({ route }: { route: AlertScheduleRoute }) {
  const state = ALERT_HEALTH[alertHealth(route)];
  return (
    <Tooltip title={state.help}>
      <Chip size="small" variant="outlined" color={state.chipColor} label={state.label} />
    </Tooltip>
  );
}
