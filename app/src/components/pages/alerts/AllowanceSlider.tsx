import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Slider from "@mui/material/Slider";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { api } from "../../../api";
import { ApiError } from "../../../api/client";

/**
 * The one setting on the Alerts page: the scheduler's share of the day's
 * seats.aero calls.
 *
 * It sits in the cadence panel rather than the settings dialog because every
 * number beside it is derived from it, and a knob you cannot see the effect of
 * is a knob you turn twice. Dragging previews the split from the limit the
 * server quoted; releasing writes it, and the schedule refetch replaces the
 * preview with what the scheduler will actually use. That refetch is the whole
 * feedback loop, so the draft is cleared on success rather than kept.
 */
export function AllowanceSlider({
  pct,
  dailyLimit,
  dailyBudget,
}: {
  pct: number;
  dailyLimit: number;
  dailyBudget: number;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: (allowancePct: number) => api.setAlertAllowance({ allowancePct }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["alert-schedule"] });
    },
  });

  const shown = draft ?? pct;
  const budget = draft == null ? dailyBudget : Math.floor((dailyLimit * draft) / 100);

  const help = `${shown}% of the day’s ${dailyLimit} seats.aero calls, about ${budget}, may go to the scheduler. The other ${dailyLimit - budget} are kept for manual searches.`;

  return (
    <Box sx={{ width: 240 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        Alert allowance
      </Typography>
      <Tooltip title={help}>
        <Slider
          value={shown}
          min={0}
          max={100}
          step={1}
          marks={[
            { value: 0, label: "0%" },
            { value: 50, label: "50%" },
            { value: 100, label: "100%" },
          ]}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `${v}%`}
          aria-label="Alert allowance"
          disabled={save.isPending}
          onChange={(_, v) => setDraft(v as number)}
          onChangeCommitted={(_, v) => {
            const next = v as number;
            if (next === pct) setDraft(null);
            else save.mutate(next);
          }}
          sx={{ mx: 1, width: "calc(100% - 16px)" }}
        />
      </Tooltip>
      {save.isError && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => save.reset()}>
          {(save.error instanceof ApiError && save.error.detail) || "Could not save the allowance."}
        </Alert>
      )}
    </Box>
  );
}
