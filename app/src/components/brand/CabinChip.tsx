import { Chip, alpha, useTheme } from "@mui/material";
import { readable } from "../../theme/build";
import { CABIN_COLOR, NEUTRAL_COLOR, resolveColor } from "../../lib/currencies";

export function CabinChip({ cabin }: { cabin: string }) {
  const theme = useTheme();
  const color = readable(
    resolveColor(CABIN_COLOR[cabin] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
    theme,
  );
  return (
    <Chip
      size="small"
      label={cabin}
      sx={{
        textTransform: "capitalize",
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    />
  );
}