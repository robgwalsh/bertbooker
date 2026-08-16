import { Chip, Stack, Typography } from "@mui/material";

export function SectionHeader({
  title,
  icon,
  count,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ mb: 2, alignItems: "center" }}>
      {icon}
      <Typography variant="h5">{title}</Typography>
      {count !== undefined && (
        <Chip
          size="small"
          label={count}
          sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }}
        />
      )}
    </Stack>
  );
}
