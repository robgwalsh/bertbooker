import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { CallRow } from "./CallRow";
import { usDate } from "./dates";
import { CHUNK_STATUS } from "./chunkTimeline";
import type { ChunkState, RunState } from "./useRouteSearch";
import type { SearchCall } from "../../api";

function ChunkIcon({ kind }: { kind: "pending" | "running" | "ok" | "bad" }) {
  const sx = { fontSize: 16 };
  if (kind === "running") return <CircularProgress size={14} />;
  if (kind === "ok") return <CheckCircleOutlineRoundedIcon color="success" sx={sx} />;
  if (kind === "bad") return <ErrorOutlineRoundedIcon color="error" sx={sx} />;
  return <RadioButtonUncheckedRoundedIcon sx={{ ...sx, color: "text.disabled" }} />;
}

function ChunkBlock({ chunk, onOpenCall }: { chunk: ChunkState; onOpenCall: (c: SearchCall) => void }) {
  const meta = CHUNK_STATUS[chunk.status];
  const detail =
    chunk.status === "ok"
      ? `${chunk.offersFound ?? 0} offer${chunk.offersFound === 1 ? "" : "s"}${
          chunk.snapshotsWritten ? ` · ${chunk.snapshotsWritten} changed` : ""
        }`
      : meta.label;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <ChunkIcon kind={meta.icon} />
        <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
          {usDate(chunk.start)} – {usDate(chunk.end)}
        </Typography>
        <Tooltip title={chunk.error ?? meta.help ?? ""}>
          <Typography variant="caption" color={meta.icon === "bad" ? "error.main" : "text.secondary"}>
            {detail}
          </Typography>
        </Tooltip>
        {chunk.note && (
          // A narrowed claim is not a failure, but it IS a partial answer, and
          // it is the only place the far end of the window silently goes missing.
          <Tooltip title={chunk.note}>
            <Chip size="small" variant="outlined" color="warning" label="partial" />
          </Tooltip>
        )}
      </Stack>
      {/* The calls that produced the line above. Indented under it, because
          "which of the three calls was slow" is a question about this range,
          not about the search. */}
      {chunk.httpCalls.map((call) => (
        <CallRow key={call.index} call={call} onOpen={() => onOpenCall(call)} />
      ))}
    </Box>
  );
}

/**
 * Every range and every seats.aero call behind one search, in full.
 *
 * It is the only way to answer "why does this find look wrong", and the only
 * way to watch a slow call while it is still in flight — which is why it is
 * one button away rather than folded into the main view.
 *
 * It takes `run` straight off `useRouteSearch`'s state rather than a snapshot,
 * so it fills in LIVE while the search is still going: no extra state, no second
 * stream. Clicking a call opens `CallDialog` on top of it.
 */
export function SearchCallsDialog({
  run,
  onOpenCall,
  onClose,
}: {
  /** Absent when no route's calls are open, or when the run was dismissed out
   *  from under the dialog. */
  run: RunState | undefined;
  onOpenCall: (call: SearchCall) => void;
  onClose: () => void;
}) {
  const phone = useIsPhone();
  if (!run) return null;

  const done = run.chunks.filter((c) => c.status !== "pending" && c.status !== "running").length;

  return (
    // Full screen on a phone, like `CallDialog`: this is a dense list that a
    // modal card with 32px of backdrop either side frames badly.
    <Dialog open onClose={onClose} maxWidth="md" fullWidth fullScreen={phone}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography component="span" sx={{ fontWeight: 700 }}>
            API calls
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {done}/{run.chunks.length} ranges · {run.calls} call{run.calls === 1 ? "" : "s"} used
            {run.remaining != null &&
              ` · ${run.remaining.toLocaleString()}${
                run.limit ? `/${run.limit.toLocaleString()}` : ""
              } left today`}
          </Typography>
          {run.status === "running" && <CircularProgress size={14} />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {run.chunks.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            This search never got started, so nothing was called.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {run.chunks.map((c, i) => (
              <ChunkBlock key={i} chunk={c} onOpenCall={onOpenCall} />
            ))}
          </Stack>
        )}
        {run.error && (
          <Typography variant="caption" color="error.main" sx={{ display: "block", pt: 1 }}>
            {run.error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
