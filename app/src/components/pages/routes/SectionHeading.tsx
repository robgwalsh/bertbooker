import { Box, Chip, Stack, Typography } from "@mui/material";

/** A finds section's heading: title, an optional count chip, and an optional
 *  right-aligned action. */
export function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ mb: 2, alignItems: "center" }}>
      <Typography variant="h5">{title}</Typography>
      {count != null && (
        <Chip size="small" label={count} sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }} />
      )}
      {action && <Box sx={{ ml: "auto" }}>{action}</Box>}
    </Stack>
  );
}
