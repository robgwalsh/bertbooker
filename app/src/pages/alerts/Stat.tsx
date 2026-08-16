import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

/** One labelled number in the cadence panel. The `help` is not optional on
 *  purpose: every figure on this page is derived rather than configured, and a
 *  number with no explanation of where it came from is what makes a schedule
 *  look like a setting. */
export function Stat({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <Tooltip title={help}>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {label}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
      </Box>
    </Tooltip>
  );
}
