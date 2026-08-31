import { Chip, Tooltip } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import type { ReachVerdict, RouteFetchRecord } from "../../../api";

/**
 * What a source last said, as a chip.
 *
 * The whole vocabulary turns on one distinction: **`empty` is a SUCCESS**, and
 * it is the most informative answer this surface produces — seats.aero returns
 * `200 []` for a source name it does not recognise. Painting it as an error
 * would destroy exactly the signal the pane exists to show, so it gets its own
 * wording and its own colour, and neither is the failure one.
 */
export function FetchStatusChip({ fetch }: { fetch: RouteFetchRecord | null }) {
  const theme = useTheme();

  if (!fetch) {
    return (
      <Tooltip title="Never fetched. Nothing is known about this source's network either way.">
        <Chip size="small" variant="outlined" label="Not fetched" />
      </Tooltip>
    );
  }

  const spec = {
    ok: {
      label: `${fetch.route_count.toLocaleString()} routes`,
      color: theme.palette.success.main,
      tip: "Fetched, and this program's network is stored.",
    },
    empty: {
      label: "No routes",
      color: theme.palette.warning.main,
      tip: "The call SUCCEEDED and returned nothing. Almost always a source name seats.aero does not recognise — it answers 200 with an empty array rather than an error.",
    },
    failed: {
      label: "Failed",
      color: theme.palette.error.main,
      tip: fetch.error ?? "The call failed. Any previously stored graph is untouched.",
    },
  }[fetch.status];

  return (
    <Tooltip title={spec.tip}>
      <Chip
        size="small"
        label={spec.label}
        sx={{
          color: spec.color,
          bgcolor: alpha(spec.color, 0.14),
          border: `1px solid ${alpha(spec.color, 0.35)}`,
        }}
      />
    </Tooltip>
  );
}

/** A tracked route's reach verdict. `unknown` is deliberately not a warning:
 *  nothing has been fetched, so there is nothing to be concerned about yet. */
export function VerdictChip({ verdict }: { verdict: ReachVerdict }) {
  const theme = useTheme();
  const spec = {
    ok: {
      label: "Flown",
      color: theme.palette.success.main,
      tip: "Every pair on this route is in at least one fetched program's network.",
    },
    indirect: {
      label: "Indirect",
      // `secondary` is the theme's `indicator` — the BRIGHT half of the accent
      // pair. `primary` is a ground here and would read as washed out on text.
      color: theme.palette.secondary.main,
      tip: "No program is monitored on this pair directly, but the network reaches it with a stop. A search of the route as written still returns nothing — track the legs instead.",
    },
    gap: {
      label: "Gap",
      color: theme.palette.warning.main,
      tip: "At least one pair is in no fetched program's network, directly or through a stop. Searches of it will come back empty however often they run.",
    },
    unknown: {
      label: "Unknown",
      color: theme.palette.text.secondary,
      tip: "Nothing has been fetched yet, so there is nothing to conclude.",
    },
  }[verdict];

  return (
    <Tooltip title={spec.tip}>
      <Chip
        size="small"
        label={spec.label}
        sx={{
          color: spec.color,
          bgcolor: alpha(spec.color, 0.14),
          border: `1px solid ${alpha(spec.color, 0.35)}`,
        }}
      />
    </Tooltip>
  );
}
