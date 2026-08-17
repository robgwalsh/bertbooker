import { Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { usDate } from "./dates";
import { SearchTimeline } from "./SearchTimeline";
import { gapRanges, uncheckedRanges } from "./chunkTimeline";
import type { ChunkState, RunState } from "./useRouteSearch";

/** At most three ranges are named in the warning sentence; past that it stops
 *  being a sentence. There are never more than five (`SEATSAERO_MAX_CHUNKS`). */
const NAMED_RANGES = 3;

function rangeList(chunks: ChunkState[]): string {
  const named = chunks
    .slice(0, NAMED_RANGES)
    .map((c) => `${usDate(c.start)}–${usDate(c.end)}`)
    .join(", ");
  const rest = chunks.length - NAMED_RANGES;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * A search in progress, as a bar across the dates it covers.
 *
 * Session-scoped and deliberately transient: every finding it reports is already
 * in the database by the time its segment fills, so this is a report on the run
 * you just triggered, not a record of anything. The one thing it must do
 * faithfully is show a refused or failed range as a *gap*, since the finds table
 * below cannot — an absent row looks the same either way. That is why the gap
 * sentence names the dates in words as well as painting them: the bar says
 * "something is wrong here", the sentence says what it means for the table.
 *
 * The per-call detail this panel used to print inline lives in
 * `SearchCallsDialog`, behind the button below.
 */
export function SearchProgress({
  run,
  onShowCalls,
  onDismiss,
}: {
  run: RunState;
  onShowCalls: () => void;
  /** Absent while the run is still going — see `dismiss` in `useRouteSearch`. */
  onDismiss?: () => void;
}) {
  const done = run.chunks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const gaps = gapRanges(run.chunks);
  // Only once the run has settled: while it is going, an unchecked range is
  // simply one that hasn't come up yet.
  const unchecked = run.status === "running" ? [] : uncheckedRanges(run.chunks);

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
          the bar below is dates and colour, which read as a decoration of
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
            range it reported as a gap is still a gap in the finds below.
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
        <SearchTimeline chunks={run.chunks} />

        {/* Suppressed when the search never got started (a 503 for a missing key,
            say): "0 API calls used" beside the real reason is just noise. */}
        {run.chunks.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", pt: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
              {run.status === "running"
                ? `${done}/${run.chunks.length} ranges · ${run.calls} API call${run.calls === 1 ? "" : "s"} used`
                : `${run.calls} API call${run.calls === 1 ? "" : "s"} used`}
              {run.remaining != null &&
                ` · ${run.remaining.toLocaleString()}${
                  run.limit ? `/${run.limit.toLocaleString()}` : ""
                } left today`}
              {/* The Worker stopped inside its subrequest budget and the client
                  is re-asking. With a log scrolling past, that pause explained
                  itself; against a still bar it reads as a hang. */}
              {run.paused && " · continuing…"}
            </Typography>
            <Button size="small" onClick={onShowCalls} sx={{ flexShrink: 0 }}>
              Show API calls
            </Button>
          </Stack>
        )}

        {/* A gap is the one thing the finds table underneath physically cannot
            show. Colour alone would leave the reader to work out what a red
            segment means for the rows below, so it is also said. */}
        {gaps.length > 0 && (
          <Typography variant="caption" color="error.main">
            No answer for {rangeList(gaps)} — those dates were not checked, which is not the same
            as having no award space.
          </Typography>
        )}
        {unchecked.length > 0 && (
          <Typography variant="caption" color="error.main">
            {rangeList(unchecked)} {unchecked.length === 1 ? "was" : "were"} never checked — the
            results below are incomplete for those dates.
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
