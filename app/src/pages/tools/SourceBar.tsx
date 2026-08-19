import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { ApiError, api, type RouteGraphSource } from "../../api";
import { sinceLabel } from "../../lib/format";
import { FetchStatusChip } from "./chips";

/**
 * Pick a source, see what it last said, and refresh it.
 *
 * **The only control in this pane that spends a seats.aero call**, and it spends
 * exactly one. It neither announces the cost nor asks first — this app spends
 * first and reports after everywhere else, and `alerts/budget.ts` stays the one
 * place that checks a budget before spending.
 *
 * Picking a source that has **never been fetched** fetches it, because the
 * alternative is a pane that answers every question with "nothing is known yet"
 * until you press a second button. Three things keep that from being a call
 * spent by accident:
 *
 * - It fires on an explicit **selection**, never on mount. Opening the tab must
 *   cost nothing, and the UI harness clicks that tab on every run.
 * - Only a source with **no fetch record at all**. A `failed` one has been asked
 *   already; retrying it is what Refresh is for, and auto-retrying would spend a
 *   call every time someone flipped back to it.
 * - **Once per source per session** (`autoFetched`), so a fetch that errors
 *   before it can record anything cannot become a loop.
 */
export function SourceBar({
  sources,
  selected,
  onSelect,
}: {
  sources: RouteGraphSource[];
  selected: string;
  onSelect: (source: string) => void;
}) {
  const qc = useQueryClient();
  const autoFetched = useRef(new Set<string>());

  const current = sources.find((s) => s.source === selected);

  const fetchGraph = useMutation({
    // Keyed so the pane can tell "not fetched yet" from "being fetched right
    // now" (`useIsMutating`) without the mutation having to be lifted out of the
    // one component that owns the button.
    mutationKey: ["route-graph", "fetch"],
    // The source is a mutation VARIABLE rather than a closure over `selected`:
    // the auto-fetch below fires in the same tick as the state change that
    // selects it, so the closure would still hold the previous source.
    mutationFn: (source: string) => api.fetchRouteGraph(source),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["route-graph"] });
      void qc.invalidateQueries({ queryKey: ["quota"] });
    },
  });

  function select(next: string) {
    onSelect(next);
    const target = sources.find((s) => s.source === next);
    if (target?.fetch || autoFetched.current.has(next) || fetchGraph.isPending) return;
    autoFetched.current.add(next);
    fetchGraph.mutate(next);
  }

  const mapped = sources.filter((s) => s.program && !s.knownEmpty);
  const unmapped = sources.filter((s) => !s.program && !s.knownEmpty);
  const empties = sources.filter((s) => s.knownEmpty);

  return (
    <>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        // `flex-start` below `sm` so a Chip keeps its own width instead of
        // being stretched the width of the column by the default `stretch`.
        sx={{ alignItems: { xs: "flex-start", sm: "center" }, flexWrap: "wrap", mb: 2 }}
      >
        <Select
          size="small"
          value={selected}
          onChange={(e) => select(e.target.value)}
          // Named for the UI harness. The pane renders the pair lookup's
          // airport autocompletes — also comboboxes — while this one is still
          // waiting on its query, so "the first combobox" is whichever of them
          // happened to mount first.
          data-testid="source-select"
          sx={{ minWidth: 240 }}
        >
          <ListSubheader>Programs this app can book</ListSubheader>
          {mapped.map((s) => (
            <MenuItem key={s.source} value={s.source}>
              {s.label}
            </MenuItem>
          ))}
          <ListSubheader>Real, but not bookable from here</ListSubheader>
          {unmapped.map((s) => (
            <MenuItem key={s.source} value={s.source}>
              {s.label}
            </MenuItem>
          ))}
          <ListSubheader>Names seats.aero does not know</ListSubheader>
          {empties.map((s) => (
            <MenuItem key={s.source} value={s.source}>
              {s.label}
            </MenuItem>
          ))}
        </Select>

        <FetchStatusChip fetch={current?.fetch ?? null} />

        {current?.fetch && (
          <Typography variant="body2" color="text.secondary">
            fetched {sinceLabel(current.fetch.fetched_at)}
          </Typography>
        )}

        <Button
          size="small"
          variant="contained"
          startIcon={<DownloadRoundedIcon />}
          disabled={!selected || fetchGraph.isPending}
          onClick={() => fetchGraph.mutate(selected)}
          sx={{ ml: { sm: "auto" } }}
        >
          {fetchGraph.isPending ? "Fetching…" : current?.fetch ? "Refresh" : "Fetch"}
        </Button>
      </Stack>

      {current?.knownEmpty && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>{current.source}</strong> is one of the names that looks like a source and
          is not. Fetching it returns <code>200 []</code> — a success with nothing in it, which
          is why every source's fetch is recorded rather than inferred from whether rows exist.
        </Alert>
      )}

      {fetchGraph.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {fetchGraph.error instanceof ApiError && fetchGraph.error.code === "no_seats_aero_key"
            ? "No seats.aero API key is configured, so nothing was fetched — this is not an empty result."
            : `Fetch failed: ${String(fetchGraph.error)}`}
        </Alert>
      )}
    </>
  );
}
