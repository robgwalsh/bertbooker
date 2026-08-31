import { useMemo, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { api, ENRICH_MAX_PER_RUN, type Find, type SearchCall, type TrackedRoute } from "../../../api/index";
import { PagePad } from "../../PagePad";
import { useIsNarrow } from "../../../hooks/useBreakpoints";
import { useAirportNames } from "../../../hooks/useAirportNames";
import { usePreferences } from "../../../lib/preferences";
import { PRIMARY_METERED_SOURCE } from "../../../lib/quota";
import { parseCodes } from "../../../lib/routeShape";
import { pairRoundTrips, splitDirections } from "../../../lib/roundtrip";
import { splitDirectAndLegs, stitchJourneys, type JourneyResult } from "../../../lib/multiLeg";
import { FindsTable } from "./FindsTable";
import { MultiLegTable } from "./MultiLegTable";
import { RoundTripTable } from "./RoundTripTable";
import { useRouteSearch } from "./useRouteSearch";
import { useRouteEnrich } from "./useRouteEnrich";
import { ROUTE_FILTER_MUTATION_KEY } from "./useRouteFilterPatch";
import { AddRouteDialog } from "./AddRouteDialog";
import { EditRouteDialog } from "./EditRouteDialog";
import { CallDialog } from "./CallDialog";
import { SearchCallsDialog } from "./SearchCallsDialog";
import { EnrichProgress } from "./EnrichProgress";
import { SearchProgress } from "./SearchProgress";
import { SectionHeading } from "./SectionHeading";
import { RouteHeader } from "./RouteHeader";
import { RouteNav, type RouteCount } from "./RouteNav";
import { RemoveRouteDialog } from "./RemoveRouteDialog";
import { RAIL_MAX_WIDTH } from "./constants";
import { directionArrow, sideLabel } from "./labels";
import type { EditTarget } from "./form";
import type { RoutesSearchParams } from "./searchParams";

const EMPTY_JOURNEYS: JourneyResult = {
  journeys: [],
  considered: 0,
  truncated: false,
  hubs: [],
  outboundSlots: 0,
  inboundSlots: 0,
};

export function RoutesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["routes"],
    queryFn: api.routes,
  });

  const savingFilter = useIsMutating({ mutationKey: ROUTE_FILTER_MUTATION_KEY }) > 0;
  const alertSchedule = useQuery({
    queryKey: ["alert-schedule"],
    queryFn: api.alertSchedule,
    retry: false,
  });
  const alertById = useMemo(
    () => new Map((alertSchedule.data?.routes ?? []).map((r) => [r.id, r])),
    [alertSchedule.data],
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editRoute, setEditRoute] = useState<EditTarget | null>(null);
  const [confirmDel, setConfirmDel] = useState<TrackedRoute | null>(null);
  const [confirmEnrich, setConfirmEnrich] = useState<{
    route: TrackedRoute;
    calls: number;
  } | null>(null);
  const [openCall, setOpenCall] = useState<SearchCall | null>(null);
  // Which route's call log is open. The ROUTE ID, not the run — the dialog reads
  // through `search.runs[callsFor]` so it keeps filling in while the search runs.
  const [callsFor, setCallsFor] = useState<number | null>(null);
  const search = useRouteSearch();
  const enrich = useRouteEnrich();
  const prefs = usePreferences();
  const narrow = useIsNarrow();
  const navigate = useNavigate({ from: "/" });
  const {
    route: routeParam,
    minNights: minParam,
    maxNights: maxParam,
  } = useSearch({ from: "/" });
  // Absent means the route's own window — the default reading, which filters
  // nothing. Only a range somebody actually chose lives in the URL, and half a
  // range is not a range (`validateSearch` drops the pair together).
  const nights: [number, number] | null =
    minParam != null && maxParam != null ? [minParam, maxParam] : null;

  // Every navigate on this page MERGES rather than replaces. `search: { route }`
  // would drop `view` and the nights range on the floor, so clicking a rail entry
  // would silently close the round-trip view you were reading.
  const setSearch = (patch: Partial<RoutesSearchParams>, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });

  // Shared key with QuotaIndicator and the finds table's per-row control, so the
  // confirm dialog can quote today's allowance without a fetch of its own.
  const quotaQ = useQuery({ queryKey: ["quota"], queryFn: api.quota });
  const quotaLeft = quotaQ.data?.quota.find(
    (q) => q.source === PRIMARY_METERED_SOURCE && q.day === quotaQ.data?.today,
  )?.remaining;

  const names = useAirportNames(
    (data?.trackedRoutes ?? []).flatMap((r) => [
      ...parseCodes(r.origins, r.origin),
      ...parseCodes(r.destinations, r.destination),
    ]),
  );

  const searchAfterSave = (id: number) => {
    setSearch({ route: id });
    search.start(id);
  };

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTrackedRoute(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      setConfirmDel(null);
    },
  });

  if (isLoading)
    return (
      <Stack sx={{ py: 8, alignItems: "center" }}>
        <CircularProgress />
      </Stack>
    );
  if (error) return <Alert severity="error">Failed to load: {String(error)}</Alert>;
  if (!data) return null;

  // Group current finds under the route that monitors them (tagged server-side).
  const findsByRoute = new Map<number, Find[]>();
  for (const f of data.matchingFinds) {
    if (f.tracked_route_id == null) continue;
    const arr = findsByRoute.get(f.tracked_route_id) ?? [];
    arr.push(f);
    findsByRoute.set(f.tracked_route_id, arr);
  }
  // Fall back to the first route rather than an empty pane: `?route=` can name a
  // route that has since been deleted, or a number someone typed.
  const selected =
    data.trackedRoutes.find((r) => r.id === routeParam) ??
    (narrow ? undefined : data.trackedRoutes[0]);

  const journeysByRoute = new Map<number, JourneyResult>(
    data.trackedRoutes
      .filter((r) => r.round_trip !== 1)
      .map((r) => [r.id, stitchJourneys(r, data.matchingFinds)]),
  );

  const counts = new Map<number, RouteCount>(
    data.trackedRoutes.map((r) => {
      const fs = findsByRoute.get(r.id) ?? [];
      if (r.round_trip !== 1) {
        return [
          r.id,
          {
            found: splitDirectAndLegs(r, fs).direct.length,
            roundTrip: false,
            viaJourneys: journeysByRoute.get(r.id)?.considered ?? 0,
          },
        ];
      }
      const { outbound, inbound } = splitDirections(r, fs);
      const paired = pairRoundTrips(
        outbound,
        inbound,
        nights && r.id === selected?.id
          ? {
              mode: "nights",
              minNights: nights[0],
              maxNights: nights[1],
              pointLimit: r.point_limit,
            }
          : {
              mode: "dates",
              departOn: r.date_start,
              returnOn: r.date_end,
              pointLimit: r.point_limit,
            },
      );
      return [r.id, { found: paired.considered, roundTrip: true }];
    }),
  );

  return (
    <Box sx={{ height: "100%", minHeight: 0 }}>
      {data.trackedRoutes.length === 0 ? (
        <PagePad>
          <SectionHeading
            title="Routes"
            action={
              <Button
                variant="contained"
                size="small"
                startIcon={<AddRoundedIcon />}
                onClick={() => setAddOpen(true)}
              >
                New route
              </Button>
            }
          />
          <Typography color="text.secondary" variant="body2">
            No routes yet. Add one, then press Search to look for award space.
          </Typography>
        </PagePad>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: `fit-content(${RAIL_MAX_WIDTH}px) minmax(0, 1fr)`,
            },
            height: "100%",
            minHeight: 0,
            overflowY: "hidden",
          }}
        >
          {(!narrow || !selected) && (
            <RouteNav
              routes={data.trackedRoutes}
              counts={counts}
              names={names}
              alerts={alertById}
              selectedId={selected?.id}
              onSelect={(id) => setSearch({ route: id })}
              onAdd={() => setAddOpen(true)}
              onDelete={(r) => setConfirmDel(r)}
              deletingId={del.isPending ? del.variables : undefined}
            />
          )}
          {data.trackedRoutes
            .filter((r) => r.id === selected?.id)
            .map((r) => {
              const { direct: routeFinds } = splitDirectAndLegs(r, findsByRoute.get(r.id) ?? []);
              const run = search.runs[r.id];
              const running = search.isRunning(r.id);
              const enrichRun = enrich.runs[r.id];
              const enriching = enrich.isRunning(r.id);
              const enrichable = new Set(
                routeFinds
                  .filter((f) => f.detail_level === "summary" && f.source_record_id)
                  .map((f) => f.source_record_id as string),
              );
              return (
                <Box
                  key={r.id}
                  sx={{
                    minWidth: 0,
                    minHeight: 0,
                    overflowY: "auto",
                  }}
                >
                  <RouteHeader
                    route={r}
                    names={names}
                    alert={alertById.get(r.id)}
                    intervalMinutes={alertSchedule.data?.pacing.intervalMinutes}
                    onEdit={(focus) => setEditRoute({ route: r, focus })}
                    onBack={() => setSearch({ route: undefined })}
                    refreshing={savingFilter || (isFetching && !isLoading)}
                    actions={
                      <>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => search.start(r.id)}
                          disabled={running}
                          startIcon={
                            running ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <SearchRoundedIcon fontSize="small" />
                            )
                          }
                        >
                          {running ? "Searching…" : r.last_checked_at ? "Re-search" : "Search"}
                        </Button>
                        {(enrichable.size > 0 || enriching) && (
                          <Tooltip
                            title={
                              enriching
                                ? "Fetching real flight numbers and times"
                                : `${enrichable.size} find${
                                    enrichable.size === 1 ? "" : "s"
                                  } here are summaries — fetch their real itineraries`
                            }
                          >
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={enriching || running}
                                onClick={() =>
                                  setConfirmEnrich({ route: r, calls: enrichable.size })
                                }
                                startIcon={
                                  enriching ? (
                                    <CircularProgress size={16} color="inherit" />
                                  ) : (
                                    <AltRouteRoundedIcon fontSize="small" />
                                  )
                                }
                              >
                                {enriching
                                  ? `Enriching ${enrichRun?.done ?? 0}/${enrichRun?.targets ?? 0}…`
                                  : "Enrich all"}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </>
                    }
                  />

                  {run && (
                    <SearchProgress
                      run={run}
                      onShowCalls={() => setCallsFor(r.id)}
                      onDismiss={running ? undefined : () => search.dismiss(r.id)}
                    />
                  )}
                  {enrichRun && (
                    <EnrichProgress
                      run={enrichRun}
                      onDismiss={enriching ? undefined : () => enrich.dismiss(r.id)}
                    />
                  )}

                  {r.round_trip === 1 ? (
                    <RoundTripTable
                      route={r}
                      finds={routeFinds}
                      nights={nights}
                      onSearch={(id) => search.start(id)}
                      searching={running}
                      showMap={prefs.showMapColumn}
                      onNightsChange={(n) =>
                        setSearch({ minNights: n?.[0], maxNights: n?.[1] }, true)
                      }
                    />
                  ) : (
                    <>
                      {routeFinds.length > 0 ? (
                        <FindsTable
                          finds={routeFinds}
                          paginate
                          showMap={prefs.showMapColumn}
                        />
                      ) : null}
                      {routeFinds.length === 0 &&
                      (journeysByRoute.get(r.id)?.journeys.length ?? 0) === 0 ? (
                        <Typography
                          color="text.secondary"
                          variant="body2"
                          sx={{ px: 2.5, py: 2 }}
                        >
                          {r.last_checked_at
                            ? "No award space stored for this window right now."
                            : "This route has never been searched. Press Search to look for award space."}
                        </Typography>
                      ) : null}
                      <MultiLegTable
                        result={journeysByRoute.get(r.id) ?? EMPTY_JOURNEYS}
                        showMap={prefs.showMapColumn}
                      />
                    </>
                  )}
                </Box>
              );
            })}
        </Box>
      )}

      <AddRouteDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
        }}
        onCreated={searchAfterSave}
      />
      <EditRouteDialog
        target={editRoute}
        onClose={() => setEditRoute(null)}
        onSaved={searchAfterSave}
      />

      <RemoveRouteDialog
        route={confirmDel}
        names={names}
        count={confirmDel ? counts.get(confirmDel.id) : undefined}
        busy={del.isPending}
        onCancel={() => setConfirmDel(null)}
        onConfirm={(id) => del.mutate(id)}
      />

      <Dialog
        open={!!confirmEnrich}
        onClose={() => setConfirmEnrich(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Fetch itineraries?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirmEnrich?.route.origin}&nbsp;{confirmEnrich && directionArrow(confirmEnrich.route)}&nbsp;{confirmEnrich?.route.destination} has{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {confirmEnrich?.calls} summary find{confirmEnrich?.calls === 1 ? "" : "s"}
            </Box>{" "}
            with no flight numbers. Fetching them costs{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {Math.min(confirmEnrich?.calls ?? 0, ENRICH_MAX_PER_RUN)} seats.aero call
              {Math.min(confirmEnrich?.calls ?? 0, ENRICH_MAX_PER_RUN) === 1 ? "" : "s"}
            </Box>
            {quotaLeft != null && ` of the ${quotaLeft.toLocaleString()} left today`}.
            {(confirmEnrich?.calls ?? 0) > ENRICH_MAX_PER_RUN &&
              ` Capped at ${ENRICH_MAX_PER_RUN} per run — the nearest dates go first, and you can run it again for the rest.`}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmEnrich(null)} color="inherit">
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<AltRouteRoundedIcon />}
            onClick={() => {
              if (!confirmEnrich) return;
              enrich.start(confirmEnrich.route.id);
              setConfirmEnrich(null);
            }}
          >
            Fetch
          </Button>
        </DialogActions>
      </Dialog>

      <SearchCallsDialog
        run={callsFor == null ? undefined : search.runs[callsFor]}
        onOpenCall={setOpenCall}
        onClose={() => setCallsFor(null)}
      />

      <CallDialog call={openCall} onClose={() => setOpenCall(null)} />
    </Box>
  );
}
