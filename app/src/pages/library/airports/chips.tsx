import { Chip } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { readable } from "../../../theme/build";
import { TYPE_LABEL } from "../../../lib/airportTypes";

export function TypeChip({ type }: { type: string }) {
  const theme = useTheme();
  const known = TYPE_LABEL[type];
  const label = known?.label ?? type.replace(/_/g, " ");
  // An unknown airport type has no colour of its own; the old slate-grey literal
  // was legible only on the near-black theme it was written against.
  const color = readable(known?.color ?? theme.palette.text.secondary, theme);
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.3)}`,
      }}
    />
  );
}

// A chip that toggles a boolean filter on/off.
export function ToggleChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Chip
      label={label}
      onClick={onToggle}
      variant={active ? "filled" : "outlined"}
      color={active ? "primary" : "default"}
      sx={{ fontWeight: 600 }}
    />
  );
}
