import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import { formatInterval } from "../../lib/alerts";
import { Stat } from "./Stat";
import type { AlertSchedule } from "../../api";

/**
 * How often the sweep runs, and what it is spending.
 *
 * **Nothing here is computed on the client.** `docs/ALERTS.md` §4 is explicit
 * that a page quoting a schedule the scheduler does not keep is worse than a
 * page with no schedule on it, so every figure arrives already decided in
 * `AlertSchedule` — this only names and formats what the server said.
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
  );
}
