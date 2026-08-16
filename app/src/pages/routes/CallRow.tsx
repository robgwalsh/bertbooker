import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { bytesLabel, callSummary } from "./callFormat";
import type { SearchCall } from "../../api";

export function CallRow({ call, onOpen }: { call: SearchCall; onOpen: () => void }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      onClick={onOpen}
      sx={{
        alignItems: "center",
        cursor: "pointer",
        borderRadius: 0.5,
        px: 0.5,
        ml: 3,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Chip
        size="small"
        variant="outlined"
        color={call.ok ? "default" : "error"}
        label={call.status ?? "—"}
        sx={{ height: 18, fontSize: 10, "& .MuiChip-label": { px: 0.75 } }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {callSummary(call.url)}
      </Typography>
      <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
        {call.durationMs} ms
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
        {bytesLabel(call.bytes)}
        {call.rows != null && ` · ${call.rows} rows`}
      </Typography>
    </Stack>
  );
}
