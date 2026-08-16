import { Chip, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { readable } from "../../theme/build";
import { ALLIANCE } from "./brands";

export function AllianceChip({ alliance }: { alliance: string | null }) {
  const theme = useTheme();
  const a = alliance ? ALLIANCE[alliance] : undefined;
  if (!a) return null;
  // oneworld's gold is the case this exists for: unreadable as chip text on any
  // light theme, unchanged on every dark one.
  const color = readable(a.color, theme);
  return (
    <Chip
      size="small"
      label={a.label}
      sx={{
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    />
  );
}
