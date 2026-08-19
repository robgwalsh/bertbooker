import { useMemo, useState } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import { api, type RouteGraphOpts, type RouteGraphRow } from "../../api";
import { useDebounced } from "../../hooks/useDebounced";
import { usePreferences } from "../../lib/preferences";
import { miles } from "../../lib/format";
import { SectionHeader } from "../../components/SectionHeader";
import { SourceBar } from "./SourceBar";
import { RouteGraphMap } from "./RouteGraphMap";
import { DISTANCE_BANDS, REGIONS, ROUTE_GEO_LIMIT, ROUTE_TABLE_LIMIT } from "./filters";

/**
 * Which city pairs each program's award inventory is actually monitored on.
 *
 * Everything here reads a graph cached in D1. `SourceBar` is the only thing in
 * the app outside Search and enrich that spends a seats.aero call — one per
 * program, on Refresh or on first picking a program nobody has fetched — which
 * is the reason the cache exists at all: browsing twenty-six programs live would
 * be twenty-six calls every time this tab was opened.
 *
 * **Opening this tab is free, and must stay that way.** The auto-fetch fires on
 * an explicit selection and never on mount, which is what lets the UI harness
 * visit this page every run; `e2e/fixtures.ts` fails any test that reaches
 * `POST /api/seatsaero/sources/:source/fetch`. See `docs/SEATS-AERO.md` §12.
 */
export function CoveragePane() {
  const prefs = usePreferences();
  const [source, setSource] = useState("alaska");
  // Seeded from the preference ONCE, not bound to it: this is a filter someone
  // is about to edit, and a live binding would yank the box out from under them
  // whenever the setting changed in another tab. `usePreferences` is a
  // `useSyncExternalStore`, so the seed is there before first paint rather than
  // arriving in an effect and blanking what they just typed.
  const [input, setInput] = useState(prefs.defaultAirport);
  const q = useDebounced(input.trim(), 250);
  const [originRegion, setOriginRegion] = useState("");
  const [destinationRegion, setDestinationRegion] = useState("");
  const [band, setBand] = useState(0);

  const sourcesQ = useQuery({
    queryKey: ["route-graph", "sources"],
    queryFn: api.routeGraphSources,
    // This list only changes when someone presses Fetch, and `SourceBar`
    // invalidates the key when they do. Without this it refetches on every
    // window focus, and the re-render closes an open source menu under the
    // pointer — which is how the UI test found it.
    staleTime: Infinity,
  });

  // Picking a never-fetched source fetches it (see `SourceBar`), so "nothing is
  // known about this program" and "we are finding out right now" are different
  // states of the same empty pane. Read off the mutation's key rather than
  // lifting the mutation up here, since the button below owns it.
  const fetching = useIsMutating({ mutationKey: ["route-graph", "fetch"] }) > 0;

  const distance = DISTANCE_BANDS[band] ?? DISTANCE_BANDS[0]!;
  const criteria: RouteGraphOpts = useMemo(
    () => ({
      q,
      originRegion,
      destinationRegion,
      minDistance: distance.min,
      maxDistance: distance.max,
    }),
    [q, originRegion, destinationRegion, distance.min, distance.max],
  );

  // One identity string for both queries, so the table and the map can never be
  // looking at different criteria — the same arrangement the Airports pane uses.
  const searchKey = [source, q, originRegion, destinationRegion, band];

  const current = sourcesQ.data?.find((s) => s.source === source);
  // A source with no fetch record has nothing to query for. Asking anyway would
  // return an empty list that reads exactly like "this program flies nowhere".
  const hasGraph = Boolean(current?.fetch && current.fetch.status !== "failed");

  const tableQ = useQuery({
    queryKey: ["route-graph", "table", ...searchKey],
    queryFn: () => api.routeGraph(source, { ...criteria, limit: ROUTE_TABLE_LIMIT }),
    enabled: hasGraph,
    placeholderData: (prev) => prev,
  });

  const geoQ = useQuery({
    queryKey: ["route-graph", "geo", ...searchKey],
    queryFn: () => api.routeGraphGeo(source, { ...criteria, limit: ROUTE_GEO_LIMIT }),
    enabled: hasGraph,
    placeholderData: (prev) => prev,
  });

  const rows = tableQ.data ?? [];

  return (
    <Box>
      <SectionHeader
        title="Data coverage"
        icon={<HubRoundedIcon sx={{ color: "secondary.main" }} />}
      />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Which city pairs a program&rsquo;s award inventory is monitored on
      </Typography>

      {sourcesQ.isLoading && (
        <Stack sx={{ py: 6, alignItems: "center" }}>
          <CircularProgress />
        </Stack>
      )}
      {sourcesQ.error && (
        <Alert severity="error">Failed to load sources: {String(sourcesQ.error)}</Alert>
      )}

      {sourcesQ.data && (
        <>
          <SourceBar sources={sourcesQ.data} selected={source} onSelect={setSource} />

          {!hasGraph && fetching ? (
            <Stack direction="row" spacing={1.5} sx={{ py: 4, alignItems: "center" }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Fetching this program&rsquo;s route graph…
              </Typography>
            </Stack>
          ) : !hasGraph ? (
            <Alert severity="info">
              {current?.fetch?.status === "failed"
                ? "The last fetch of this source failed, so nothing here is authoritative. Try again."
                : "This source has not been fetched yet. Nothing is known about its network either way — which is different from it flying nowhere."}
            </Alert>
          ) : current?.fetch?.status === "empty" ? (
            <Alert severity="warning">
              This source returned <strong>no routes at all</strong>. The call succeeded —
              seats.aero answers <code>200 []</code> for a name it does not recognise, so this
              almost certainly is not a real source.
            </Alert>
          ) : (
            <>
              <Stack
                direction="row"
                spacing={1.5}
                sx={{ flexWrap: "wrap", gap: 1.5, mb: 2, alignItems: "center" }}
              >
                <TextField
                  size="small"
                  label="Airport or city"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  sx={{ minWidth: 220 }}
                />
                <Select
                  size="small"
                  displayEmpty
                  value={originRegion}
                  onChange={(e) => setOriginRegion(e.target.value)}
                  sx={{ minWidth: 160 }}
                >
                  <MenuItem value="">From anywhere</MenuItem>
                  {REGIONS.map((r) => (
                    <MenuItem key={r} value={r}>
                      From {r}
                    </MenuItem>
                  ))}
                </Select>
                <Select
                  size="small"
                  displayEmpty
                  value={destinationRegion}
                  onChange={(e) => setDestinationRegion(e.target.value)}
                  sx={{ minWidth: 160 }}
                >
                  <MenuItem value="">To anywhere</MenuItem>
                  {REGIONS.map((r) => (
                    <MenuItem key={r} value={r}>
                      To {r}
                    </MenuItem>
                  ))}
                </Select>
                <Select
                  size="small"
                  value={band}
                  onChange={(e) => setBand(Number(e.target.value))}
                  sx={{ minWidth: 150 }}
                >
                  {DISTANCE_BANDS.map((b, i) => (
                    <MenuItem key={b.label} value={i}>
                      {b.label}
                    </MenuItem>
                  ))}
                </Select>
              </Stack>

              {/* Map and list side by side from `md` up, stacked below it.
                  The map takes the room that is left (`flex: 1`, and
                  `minWidth: 0` so a wide table cannot push the whole row into
                  a horizontal scroll); the list takes only what its columns
                  need — `flex: 0 0 auto` with a `max-content` table inside,
                  capped so a long airport name cannot claim half the pane. */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ mb: 3 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <RouteGraphMap
                    edges={geoQ.data?.edges ?? []}
                    total={geoQ.data?.total ?? 0}
                    truncated={geoQ.data?.truncated ?? false}
                    loading={geoQ.isFetching}
                    fitKey={searchKey.join("|")}
                  />
                </Box>
                <Box sx={{ flex: { md: "0 0 auto" }, maxWidth: { md: "45%" }, minWidth: 0 }}>
                  <RouteTable rows={rows} loading={tableQ.isFetching} total={geoQ.data?.total} />
                </Box>
              </Stack>
            </>
          )}
        </>
      )}
    </Box>
  );
}

function RouteTable({
  rows,
  loading,
  total,
}: {
  rows: RouteGraphRow[];
  loading: boolean;
  total?: number;
}) {
  if (loading && !rows.length)
    return (
      <Stack sx={{ py: 6, alignItems: "center" }}>
        <CircularProgress />
      </Stack>
    );

  if (!rows.length)
    return (
      <Typography variant="body2" color="text.secondary">
        No routes match.
      </Typography>
    );

  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {rows.length >= ROUTE_TABLE_LIMIT
          ? `First ${ROUTE_TABLE_LIMIT} of ${(total ?? rows.length).toLocaleString()} — refine to narrow`
          : `${rows.length.toLocaleString()} routes`}
      </Typography>
      {/* Scrolls itself rather than the page, so a 200-row list sitting beside
          a 420px map does not decide how tall the section is. `max-content`
          is what makes the column take only the width its cells need — the
          whole point of it being here rather than under the map. */}
      <TableContainer
        sx={{
          maxHeight: { xs: 360, md: 420 },
          border: (t) => `1px solid ${t.palette.divider}`,
        }}
      >
        {/* `max-content` and nothing else. A `minWidth: 100%` alongside it
            defeats the point: the table stretches to whatever the container is
            and the columns spread out, which is the layout this one was moved
            beside the map to avoid. */}
        <Table size="small" stickyHeader sx={{ width: "max-content" }}>
          <TableHead>
            <TableRow>
              <TableCell>From</TableCell>
              <TableCell>To</TableCell>
              <TableCell sx={{ display: { xs: "none", sm: "table-cell" } }}>Region</TableCell>
              <TableCell align="right">Distance</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.origin}>${r.destination}`} hover>
                <TableCell>
                  <Endpoint code={r.origin} city={r.origin_city} />
                </TableCell>
                <TableCell>
                  <Endpoint code={r.destination} city={r.destination_city} />
                </TableCell>
                <TableCell sx={{ display: { xs: "none", sm: "table-cell" } }}>
                  <Typography variant="caption" color="text.secondary">
                    {r.destination_region ?? "—"}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  {/* Zero occurs in the payload and means nothing useful, so it
                      shows as unknown rather than as a very short flight. */}
                  <Typography variant="body2" color="text.secondary">
                    {r.distance_mi ? miles(r.distance_mi) : "—"}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

function Endpoint({ code, city }: { code: string; city: string | null }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Chip size="small" label={code} sx={{ bgcolor: (t) => t.spec.accentMuted }} />
      {city && (
        <Typography variant="caption" color="text.secondary">
          {city}
        </Typography>
      )}
    </Stack>
  );
}
