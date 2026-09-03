import { useQuery } from "@tanstack/react-query";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import { api } from "../../../api/index";
import { SectionHeader } from "../../SectionHeader";
import { SweepHistory } from "./SweepHistory";

/**
 * The last fifteen sweeps, whatever came of them.
 *
 * A sweep that failed mails nobody, so this table and the state chip beside a
 * route are the only places a failure is written down.
 */
export function SweepHistoryPanel() {
  const runs = useQuery({ queryKey: ["alert-runs"], queryFn: () => api.alertRuns(15) });

  return (
    <Box>
      <SectionHeader
        title="Sweep history"
        icon={<HistoryRoundedIcon sx={{ color: "secondary.main" }} />}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every re-search the scheduler has run, newest first
      </Typography>
      <SweepHistory runs={runs.data ?? []} />
    </Box>
  );
}
