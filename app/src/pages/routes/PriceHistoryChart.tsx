import { Box, Stack, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { SeriesPoint } from "../../lib/priceHistory";
import { holdToNow, sparkline } from "../../lib/priceHistory";
import { miles } from "../../lib/format";

// What a slot has cost, drawn.
//
// Inline SVG and deliberately INERT, the same way `RouteMap` is: no zoom, no
// pan, no tiles, no hover layer, no charting dependency. The whole point of the
// picture is the shape of the line, and everything that would make it
// interactive is a thing that can break on a phone.
//
// The arithmetic is all in `lib/priceHistory.ts` so it can be tested; this file
// only decides colours and where the labels sit.

const HEIGHT = 120;
/** The viewBox width. The SVG scales to its container, so this is the
 *  coordinate space the paths are computed in rather than a pixel size. */
const WIDTH = 640;

export function PriceHistoryChart({
  series,
  now = Date.now(),
}: {
  series: SeriesPoint[];
  now?: number;
}) {
  const theme = useTheme();
  const held = holdToNow(series, now);
  const { segments, min, max, last } = sparkline(held, WIDTH, HEIGHT);

  if (segments.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing priced yet — this slot has only ever been seen empty.
      </Typography>
    );

  // The line goes amber once the award is gone, because at that point the last
  // thing it drew is history rather than a price you can act on.
  const stroke = last == null ? theme.palette.warning.main : theme.palette.primary.main;

  return (
    <Box>
      <Box
        component="svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Price history, ${miles(min)} to ${miles(max)}`}
        sx={{
          width: "100%",
          height: HEIGHT,
          display: "block",
          bgcolor: alpha(theme.palette.text.secondary, 0.05),
          borderRadius: 1,
        }}
      >
        {segments.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            // Non-scaling so a path stretched across a wide container keeps an
            // even weight, and round so `sparkline`'s zero-length run — a single
            // observation — renders as a dot instead of nothing.
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </Box>
      <Stack direction="row" sx={{ justifyContent: "space-between", mt: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          low {miles(min)}
        </Typography>
        {/* A break in the line is the only thing that says "gone", and a break
            is easy to read as a rendering fault. This names it. */}
        {held.some((p) => p.miles == null) && (
          <Typography variant="caption" color="warning.main">
            gaps = seen with no award
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          high {miles(max)}
        </Typography>
      </Stack>
    </Box>
  );
}
