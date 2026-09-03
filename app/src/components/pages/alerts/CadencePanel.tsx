import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import { formatInterval } from "../../../lib/alerts";
import { AllowanceSlider } from "./AllowanceSlider";
import { Stat } from "./Stat";
import type { AlertSchedule } from "../../../api";

/**
 * How often the sweep runs, what it is spending, and the one knob behind both.
 *
 * **Nothing here is computed on the client**, with one exception. `docs/ALERTS.md`
 * §4 is explicit that a page quoting a schedule the scheduler does not keep is
 * worse than a page with no schedule on it, so every figure arrives already
 * decided in `AlertSchedule` — this only names and formats what the server
 * said. The exception is the slider's drag preview, which is replaced by the
 * server's own figures the moment the value is written.
 */
export function CadencePanel({ schedule: s }: { schedule: AlertSchedule }) {
  return (
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
          label="Reserve"
          value={`${s.budget.reserve} calls`}
          help="What the allowance leaves of the day's limit. Never spent by the scheduler, so pressing Search by hand always works."
        />
        <AllowanceSlider
          pct={s.budget.allowancePct}
          dailyLimit={s.budget.dailyLimit}
          dailyBudget={s.budget.dailyBudget}
        />
      </Stack>
    </Paper>
  );
}
