import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { usDate } from "./dates";
import {
  CHUNK_STATUS,
  timelineSegments,
  type ChunkTone,
  type TimelineSegment,
} from "./chunkTimeline";
import type { ChunkState } from "./useRouteSearch";

/** Bar height. Thin enough to be a strip rather than a chart — this band sits
 *  between the route header and the finds, and the finds are the work. */
const BAR_HEIGHT = 14;

function toneFill(tone: ChunkTone, t: Theme): string {
  switch (tone) {
    case "found":
      return t.palette.success.main;
    // Deliberately still the green family, and deliberately not the same green:
    // `empty` is an ANSWER, it just isn't a hit. The one thing it must never
    // look like is `gap`.
    case "answered":
      return alpha(t.palette.success.main, 0.35);
    case "gap":
      return t.palette.error.main;
    case "running":
      return t.palette.secondary.main;
    default:
      return t.spec.accentMuted;
  }
}

function durationLabel(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms} ms`;
}

function SegmentTip({ chunk }: { chunk: ChunkState }) {
  const meta = CHUNK_STATUS[chunk.status];
  const bits: string[] = [];
  if (chunk.status === "ok") {
    bits.push(`${chunk.offersFound ?? 0} offer${chunk.offersFound === 1 ? "" : "s"}`);
    if (chunk.snapshotsWritten) bits.push(`${chunk.snapshotsWritten} changed`);
  } else if (meta.label) {
    bits.push(meta.label);
  }
  if (chunk.calls) bits.push(`${chunk.calls} call${chunk.calls === 1 ? "" : "s"}`);
  if (chunk.durationMs != null) bits.push(durationLabel(chunk.durationMs));

  return (
    <Box>
      <Typography variant="caption" sx={{ display: "block", fontFamily: "monospace" }}>
        {usDate(chunk.start)} – {usDate(chunk.end)}
      </Typography>
      {bits.length > 0 && (
        <Typography variant="caption" sx={{ display: "block" }}>
          {bits.join(" · ")}
        </Typography>
      )}
      {/* The help text is the whole reason the tooltip exists for a bad range:
          the bar can say "this is not an answer" in colour, but only words can
          say what that means for the table underneath. */}
      {meta.help && (
        <Typography variant="caption" sx={{ display: "block", opacity: 0.8 }}>
          {meta.help}
        </Typography>
      )}
      {chunk.note && (
        <Typography variant="caption" sx={{ display: "block", opacity: 0.8 }}>
          {chunk.note}
        </Typography>
      )}
      {chunk.error && (
        <Typography variant="caption" sx={{ display: "block", opacity: 0.8 }}>
          {chunk.error}
        </Typography>
      )}
    </Box>
  );
}

function Segment({ seg, chunk }: { seg: TimelineSegment; chunk: ChunkState }) {
  return (
    <Tooltip title={<SegmentTip chunk={chunk} />} placement="top" arrow>
      <Box
        sx={(t) => ({
          // Weighted by DAYS, not by count — the last chunk of a year's window
          // is routinely 6 days against 90 and must not be drawn as an equal
          // fifth of the bar.
          flexGrow: seg.days,
          flexBasis: 0,
          minWidth: 0,
          bgcolor: toneFill(seg.tone, t),
          borderLeft: seg.index === 0 ? "none" : `1px solid ${t.palette.divider}`,
          // A narrowed claim keeps its tone and takes a rule of its own: it is a
          // partial answer, not a failure, and colouring it as one would lie in
          // the other direction.
          borderBottom: seg.narrowed ? `2px solid ${t.palette.warning.main}` : "none",
          "@keyframes bbChunkPulse": {
            "0%, 100%": { opacity: 0.4 },
            "50%": { opacity: 1 },
          },
          animation: seg.tone === "running" ? "bbChunkPulse 1.2s ease-in-out infinite" : "none",
        })}
      />
    </Tooltip>
  );
}

/**
 * The window being searched, as one bar that fills in range by range.
 *
 * The per-call detail lives in `SearchCallsDialog`, one button away. The
 * question this panel answers by default is "how far along is this, and
 * which dates does it actually cover" — the question somebody watching a
 * search is asking.
 */
export function SearchTimeline({ chunks }: { chunks: ChunkState[] }) {
  const { segments, spanStart, spanEnd } = timelineSegments(chunks);
  if (segments.length === 0) return null;

  return (
    <Box>
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {usDate(spanStart)}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {usDate(spanEnd)}
        </Typography>
      </Stack>
      <Box
        sx={(t) => ({
          display: "flex",
          height: BAR_HEIGHT,
          mt: 0.25,
          border: `1px solid ${t.palette.divider}`,
          // Square, like everything else the theme draws — shape is decided in
          // `buildTheme`, not per component.
          borderRadius: 0,
          overflow: "hidden",
        })}
      >
        {segments.map((seg) => (
          <Segment key={seg.index} seg={seg} chunk={chunks[seg.index]!} />
        ))}
      </Box>
      {/* The same flex weights again, so a label sits under its own segment.
          Suppressed on a segment too narrow to hold one. */}
      <Box sx={{ display: "flex", mt: 0.25 }}>
        {segments.map((seg) => (
          <Box
            key={seg.index}
            sx={{ flexGrow: seg.days, flexBasis: 0, minWidth: 0, overflow: "hidden", px: 0.25 }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: "block", fontSize: 10 }}
            >
              {seg.showLabel ? seg.label : ""}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
