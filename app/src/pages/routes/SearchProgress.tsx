import { Box, Button, Chip, IconButton, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import CircularProgress from "@mui/material/CircularProgress";
import { CallRow } from "./CallRow";
import { usDate } from "./dates";
import type { ChunkState, RunState } from "./useRouteSearch";
import type { SearchCall } from "../../api";


/**
 * What each chunk status means to a person reading the panel.
 *
 * The distinction this table encodes is the one the whole architecture is built
 * around: `empty` is an answer ("nobody is selling award space on these dates"),
 * everything below it is the absence of an answer. They produce identical
 * results and must never read alike, because only `empty` licenses believing it.
 * Mirrors `SourceTaskStatus`, declared in shared/src/wire/domain.ts.
 */
const CHUNK_STATUS: Record<
  ChunkState["status"],
  { icon: "pending" | "running" | "ok" | "bad"; label: string; help?: string }
> = {
  pending: { icon: "pending", label: "queued" },
  running: { icon: "running", label: "searching…" },
  skipped: { icon: "pending", label: "skipped", help: "Never attempted." },
  ok: { icon: "ok", label: "" },
  empty: { icon: "ok", label: "no award space", help: "Looked, and there is genuinely nothing." },
  failed: { icon: "bad", label: "failed", help: "No answer — not the same as no space." },
  blocked: {
    icon: "bad",
    label: "refused",
    help: "seats.aero refused the call (bad or exhausted key). Nothing was learned about these dates.",
  },
  challenged: { icon: "bad", label: "challenged", help: "No answer — not the same as no space." },
  timeout: { icon: "bad", label: "timed out", help: "No answer — not the same as no space." },
};

function ChunkIcon({ kind }: { kind: "pending" | "running" | "ok" | "bad" }) {
  const sx = { fontSize: 16 };
  if (kind === "running") return <CircularProgress size={14} />;
  if (kind === "ok") return <CheckCircleOutlineRoundedIcon color="success" sx={sx} />;
  if (kind === "bad") return <ErrorOutlineRoundedIcon color="error" sx={sx} />;
  return <RadioButtonUncheckedRoundedIcon sx={{ ...sx, color: "text.disabled" }} />;
}

/**
 * A search in progress, chunk by chunk.
 *
 * Session-scoped and deliberately transient: every finding it reports is already
 * in the database by the time its line appears, so this is a diagnostic for the
 * run you just triggered, not a record of anything. The one thing it must do
 * faithfully is show a refused or failed chunk as a *gap*, since the finds table
 * below cannot — an absent row looks the same either way.
 */
export function SearchProgress({
  run,
  onOpenCall,
  onDismiss,
}: {
  run: RunState;
  onOpenCall: (call: SearchCall) => void;
  /** Absent while the run is still going — see `dismiss` in `useRouteSearch`. */
  onDismiss?: () => void;
}) {
  const done = run.chunks.filter((c) => c.status !== "pending" && c.status !== "running").length;

  return (
    // A full-bleed strip between the header and the table, not a card between
    // them: the pane is a stack of bands separated by rules, so this one takes
    // its own rule and gives up its margin and its corners.
    <Box
      sx={(t) => ({
        // The chrome ground, the same one the sidebar and the table heads use:
        // this strip is frame around the pane's work, not more of the work. It
        // was `tint(t, 0.03)` — a 3% wash of white, which is a grey on every
        // palette and therefore looked identical in all of them.
        bgcolor: t.palette.background.chrome,
        borderBottom: `1px solid ${t.palette.divider}`,
      })}
    >
      {/* A header, so the panel says what it is before it says how it went —
          the rows below are timings and ranges, which read as a log of
          something unnamed. It also gives the dismiss control somewhere
          visible to sit. */}
      <Stack
        direction="row"
        spacing={1}
        sx={(t) => ({
          alignItems: "center",
          pl: 1.25,
          pr: 0.5,
          py: 0.25,
          minHeight: 30,
          // A control strip inside the strip, so it takes the palette's own
          // "raised" ground rather than another wash of the same white.
          bgcolor: t.palette.background.raised,
          borderBottom: `1px solid ${t.palette.divider}`,
        })}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {run.status === "running"
            ? "Searching…"
            : run.status === "error"
              ? "Search failed"
              : "Search complete"}
        </Typography>
        {/* Only once the run has settled. Closing it discards nothing: every
            finding it reports was written to D1 as it landed, and a failed
            chunk it reported as a gap is still a gap in the finds below.
            Absent mid-run, when the panel is the only thing saying work is
            happening. */}
        {onDismiss && (
          <Tooltip title="Dismiss">
            <IconButton size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>
              <CloseRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      <Stack spacing={0.5} sx={{ p: 1.25 }}>
        {run.chunks.map((c, i) => {
          const meta = CHUNK_STATUS[c.status];
          const detail =
            c.status === "ok"
              ? `${c.offersFound ?? 0} offer${c.offersFound === 1 ? "" : "s"}${
                  c.snapshotsWritten ? ` · ${c.snapshotsWritten} changed` : ""
                }`
              : meta.label;
          return (
            <Box key={i}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <ChunkIcon kind={meta.icon} />
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {usDate(c.start)} – {usDate(c.end)}
                </Typography>
                <Tooltip title={c.error ?? meta.help ?? ""}>
                  <Typography
                    variant="caption"
                    color={meta.icon === "bad" ? "error.main" : "text.secondary"}
                  >
                    {detail}
                  </Typography>
                </Tooltip>
                {c.note && (
                  // A narrowed claim is not a failure, but it IS a partial answer,
                  // and it is the only place the far end of the window silently
                  // goes missing.
                  <Tooltip title={c.note}>
                    <Chip size="small" variant="outlined" color="warning" label="partial" />
                  </Tooltip>
                )}
              </Stack>
              {/* The calls that produced the line above. Indented under it,
                  because "which of the three calls was slow" is a question about
                  this range, not about the search. */}
              {c.httpCalls.map((call) => (
                <CallRow key={call.index} call={call} onOpen={() => onOpenCall(call)} />
              ))}
            </Box>
          );
        })}

        {/* Suppressed when the search never got started (a 503 for a missing key,
            say): "0 API calls used" beside the real reason is just noise. */}
        {run.chunks.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
            {run.status === "running"
              ? `${done}/${run.chunks.length} ranges · ${run.calls} API call${run.calls === 1 ? "" : "s"} used`
              : `${run.calls} API call${run.calls === 1 ? "" : "s"} used`}
            {run.remaining != null &&
              ` · ${run.remaining.toLocaleString()}${
                run.limit ? `/${run.limit.toLocaleString()}` : ""
              } left today`}
            {run.runStatus === "partial" &&
              " · some ranges were never checked — the results below are incomplete"}
          </Typography>
        )}

        {run.error && (
          <Typography variant="caption" color="error.main">
            {run.error}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
