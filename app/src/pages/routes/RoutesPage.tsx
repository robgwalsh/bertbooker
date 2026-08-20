import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { api, ENRICH_MAX_PER_RUN, type Find, type SearchCall, type TrackedRoute } from "../../api";
import { PagePad } from "../../components/PagePad";
import { useIsNarrow, useIsPhone } from "../../hooks/useBreakpoints";
import { useAirportNames } from "../../hooks/useAirportNames";
import { usePreferences } from "../../lib/preferences";
import { PRIMARY_METERED_SOURCE } from "../../lib/quota";
import { parseCodes } from "../../lib/routeShape";
import { pairRoundTrips, splitDirections } from "../../lib/roundtrip";
import { splitDirectAndLegs, stitchJourneys, type JourneyResult } from "../../lib/multiLeg";
import { FindsTable } from "./FindsTable";
import { MultiLegTable } from "./MultiLegTable";
import { RoundTripTable } from "./RoundTripTable";
import { useRouteSearch } from "./useRouteSearch";
import { useRouteEnrich } from "./useRouteEnrich";
import { AddRouteDialog } from "./AddRouteDialog";
import { EditRouteDialog } from "./EditRouteDialog";
import { CallDialog } from "./CallDialog";
import { SearchCallsDialog } from "./SearchCallsDialog";
import { EnrichProgress } from "./EnrichProgress";
import { SearchProgress } from "./SearchProgress";
import { SectionHeading } from "./SectionHeading";
import { RouteHeader } from "./RouteHeader";
import { RouteNav, type RouteCount } from "./RouteNav";
import { RAIL_MAX_WIDTH } from "./constants";
import { estimateCalls } from "./estimate";
import { directionArrow, sideLabel } from "./labels";
import type { EditTarget } from "./form";
import type { RoutesSearchParams } from "./searchParams";

/** A round-trip route is never stitched, so its pane has nothing to hand the
 *  journeys table. Module-scoped rather than an inline literal: a fresh object
 *  each render would be a new prop identity every time. */
const EMPTY_JOURNEYS: JourneyResult = {
  journeys: [],
  considered: 0,
  truncated: false,
  hubs: [],
  outboundSlots: 0,
  inboundSlots: 0,
};

export function Routes() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });

  // How each alert route's sweep is actually going, for the rail's bell and the
  // header's chip.
  //
  // The SAME key and fetcher the shell's `AlertsHealthDot` already polls every
  // five minutes (router.tsx), so this is a read of a warm cache and costs no
  // request — and deliberately carries NO `refetchInterval` of its own, because
  // a second interval on one key would fight the shell's for who refetches
  // when. `retry: false` for the same reason it has it there: alert health is
  // not itself an alarm, and a page that failed to load because of it would be.
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
  // The route the edit dialog is open on and which field it should land on,
  // `null` when it is closed — the same payload shape `confirmEnrich` uses
  // below, and what lets one mounted dialog serve every route.
  const [editRoute, setEditRoute] = useState<EditTarget | null>(null);
  const [confirmDel, setConfirmDel] = useState<TrackedRoute | null>(null);
  // The route about to be enriched, with the call count the dialog quotes.
  const [confirmEnrich, setConfirmEnrich] = useState<{
    route: TrackedRoute;
    calls: number;
  } | null>(null);
  // Held here rather than per-route so only one payload is ever mounted.
  const [openCall, setOpenCall] = useState<SearchCall | null>(null);
  // Which route's call log is open. The ROUTE ID, not the run — the dialog reads
  // through `search.runs[callsFor]` so it keeps filling in while the search runs.
  const [callsFor, setCallsFor] = useState<number | null>(null);
  // Streams, not request/responses — their partial state is the point, so they
  // live outside TanStack Query. See useRouteSearch / useRouteEnrich.
  //
  // Held HERE, at the page, rather than inside the detail pane: their state is
  // keyed by route id, so a search under a route you have navigated away from
  // keeps running and is still filling in when you come back.
  const search = useRouteSearch();
  const enrich = useRouteEnrich();

  // Display preferences for THIS browser, from localStorage — not the URL (a
  // preference should appear in no link) and not D1 (one shared identity means
  // one server-side setting for both users). Set from the header's gear.
  const prefs = usePreferences();

  // Below `md` the rail and the editor are two SCREENS rather than two panes;
  // see the workbench grid and `selected` below.
  const narrow = useIsNarrow();

  // Which route the detail pane is showing, from the URL — so a reload, a
  // bookmark and the back button all land where you left off.
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

  // Airport names for every code on screen, in one round trip.
  //
  // Every airport the page can name, not just the two scalars: the header draws
  // each origin and destination as its own pill and every one of them wants a
  // name behind it. The trip lists below resolve their own codes through the
  // same hook and the same cache — a find can route through an airport no
  // tracked route mentions.
  const names = useAirportNames(
    (data?.trackedRoutes ?? []).flatMap((r) => [
      ...parseCodes(r.origins, r.origin),
      ...parseCodes(r.destinations, r.destination),
    ]),
  );

  /**
   * What both route dialogs end in: select the route, then search it.
   *
   * A route is a *question*, and until something has looked at it the dashboard
   * cannot tell "nothing is available" from "nobody has asked" — the one
   * confusion this app is built to avoid. Editing has the same problem in
   * miniature: a window moved forward two months is mostly dates nobody has
   * checked — but only *some* edits do that, so the edit dialog offers a plain
   * Save beside this one and `EditRouteDialog` calls this for the "& search" half
   * alone. Every button that reaches here says "& search" and both dialogs quote
   * the call range above them, so the spend is stated before it happens.
   *
   * Safe to call for a route the pane hasn't rendered yet: the run state is keyed
   * by id on the page, and the endpoint is addressed by id too.
   */
  const searchAfterSave = (id: number) => {
    setSearch({ route: id });
    search.start(id);
  };

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTrackedRoute(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
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
  for (const f of data.bestFinds) {
    if (f.tracked_route_id == null) continue;
    const arr = findsByRoute.get(f.tracked_route_id) ?? [];
    arr.push(f);
    findsByRoute.set(f.tracked_route_id, arr);
  }
  // Fall back to the first route rather than an empty pane: `?route=` can name a
  // route that has since been deleted, or a number someone typed.
  //
  // A NARROW screen does not fall back, and that is what turns the workbench
  // into a list and a detail view without inventing any state to do it with.
  // With one pane on screen at a time, "no route chosen" is a real and useful
  // answer — it means the list — and picking one is what opens the editor. The
  // selection was already in the URL (`?route=`), so back, reload and bookmark
  // all keep working exactly as they did.
  const selected =
    data.trackedRoutes.find((r) => r.id === routeParam) ??
    (narrow ? undefined : data.trackedRoutes[0]);

  // What the rail's chip counts — and for a ROUND-TRIP route it is deliberately
  // NOT the number of stored finds.
  //
  // Those finds are one-way legs, and a round-trip route's pane never shows one
  // of them on its own: what you pick from is the set of PAIRS, which is a join
  // over both directions and is usually a very different number. Counting rows
  // there overstated a route whose legs mostly don't join up (dozens of finds,
  // no trip) and could understate one whose few legs pair many ways. Same
  // pairing the pane runs, so the chip and the table it opens can't disagree.
  //
  // `considered` rather than `pairs.length`: the pairing caps what it RETURNS at
  // 200 cheapest, and the chip is answering "how many are there", not "how many
  // fit on screen".
  // Ways to get there with a stop, for a route the sources hold no market on.
  //
  // Reads `data.bestFinds` and NOT `findsByRoute`, which is the whole premise:
  // the legs belong to OTHER tracked routes — SFO->ICN and ICN->KTM are ordinary
  // markets with their own routes, while SFO->KTM has none and never will.
  // Skipped for a round trip, whose pane already answers a different question
  // (`MultiLegTable`).
  const journeysByRoute = new Map<number, JourneyResult>(
    data.trackedRoutes
      .filter((r) => r.round_trip !== 1)
      .map((r) => [r.id, stitchJourneys(r, data.bestFinds)]),
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
            // Beside the find count, never inside it — see `RouteCount`.
            viaJourneys: journeysByRoute.get(r.id)?.considered ?? 0,
          },
        ];
      }
      const { outbound, inbound } = splitDirections(r, fs);
      // The trip length is a reading preference belonging to whichever route is
      // OPEN, so every other row is counted the way its pane would open — the
      // whole-window trip, the same default `RoundTripTable` starts on.
      const paired = pairRoundTrips(
        outbound,
        inbound,
        nights && r.id === selected?.id
          ? { mode: "nights", minNights: nights[0], maxNights: nights[1] }
          : { mode: "dates", departOn: r.date_start, returnOn: r.date_end },
      );
      return [r.id, { found: paired.considered, roundTrip: true }];
    }),
  );

  return (
    // The workbench: a sidebar and an editor, sharing one 1px rule and nothing
    // else. No page padding, no gap between the panes, no rounded cards — what
    // separates them is a change of GROUND (the rail is `background.chrome`, the
    // editor is `background.default`, exactly VS Code's sidebar/editor pair) plus
    // that single rule. Gaps and shadows are how a dashboard says "these are
    // different"; an editor says it with colour and a line, and gets the pixels
    // back.
    <Box sx={{ height: "100%", minHeight: 0 }}>
      {/* The seats.aero allowance this page spends is in the app bar, not here:
          the enrich control on every finds row spends it too, and a number you
          have to scroll to is one you check after the fact. See QuotaIndicator. */}
      {data.trackedRoutes.length === 0 ? (
        // With no routes there is no workbench to draw — a sidebar listing
        // nothing beside an editor showing nothing is two empty panes. So this
        // one state falls back to being a document.
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
        // `minmax(0, 1fr)` on the editor column, not `1fr`: a grid track sizes
        // to its content by default, so a wide finds table would push the rail
        // off the left edge instead of scrolling inside its own pane.
        //
        // The rail is `fit-content(RAIL_MAX)`: as narrow as the routes it holds,
        // and never wider than the cap. It was a flat 320px, which is a guess
        // about the longest route somebody might track — a rail of `PIT ⇄ SEA`
        // rows paid for `SEA/PDX/BFI ⇄ NRT/HND/KIX` whether or not one existed.
        // The cap still matters: `RailRoute`'s two lines are `noWrap`, so an
        // uncapped track would size to the longest untruncated city pair. The
        // `minWidth: 0` inside `RouteNav` is what lets the clamp bite — without
        // it those `noWrap` lines set a min-content floor the cap can't lower.
        //
        // Two scroll containers from `md` up, one below it. On a desktop each
        // pane scrolls independently, which is the entire point of a full-height
        // sidebar; on a phone the columns stack, so a pane with its own scrollbar
        // would be a short box inside a page you also have to scroll.
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: `fit-content(${RAIL_MAX_WIDTH}px) minmax(0, 1fr)`,
            },
            height: "100%",
            minHeight: 0,
            // Never the page's own scroller, at any width. Below `md` only ONE
            // of the two panes renders, and that pane scrolls itself — which is
            // also what keeps `RouteHeader` sticky against something on a phone
            // instead of against a page the rail has already been scrolled off.
            overflowY: "hidden",
          }}
        >
          {/* One pane at a time below `md`: the rail is the list screen, the
              editor is the detail screen, and `?route=` is which one you are on.
              Both render side by side from `md` up, unchanged. */}
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
              // A route with hubs gets its LEGS back under it too. They are half
              // an answer, not an answer, so the table below shows only what the
              // route is named for and the legs appear inside journeys.
              const { direct: routeFinds } = splitDirectAndLegs(r, findsByRoute.get(r.id) ?? []);
              const run = search.runs[r.id];
              const running = search.isRunning(r.id);
              const enrichRun = enrich.runs[r.id];
              const enriching = enrich.isRunning(r.id);
              // Summary finds that still carry an enrichment handle. Counted off
              // the rows on screen rather than asked of the server: the button
              // has to state a call cost before it is pressed, and this is the
              // same set the endpoint will target. One call covers a whole
              // (date, program), so the CALL count is the distinct availability
              // ids, not the row count — four cabins of one flight are one call.
              const enrichable = new Set(
                routeFinds
                  .filter((f) => f.detail_level === "summary" && f.source_record_id)
                  .map((f) => f.source_record_id as string),
              );
              return (
                // The editor pane. Its own scroller from `md` up so the header
                // and the finds table scroll past a rail that stays put.
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
                    // `setSearch` merges rather than replaces, so going back to
                    // the list keeps any nights range the route was being read
                    // with — come forward again and you are where you were.
                    onBack={() => setSearch({ route: undefined })}
                    actions={
                      <>
                        {/* Text, not an icon: this runs for tens of seconds and
                            needs to say so. Goes to the Worker, which calls
                            seats.aero — the one source that does not need a
                            residential IP — and writes what it finds into the
                            same database local gathering does. "Re-search" once the
                            route has a `last_checked_at`, so the button says
                            whether this window has ever been looked at — which is
                            now the only place the header says it, and it says it
                            on the control you are about to press. */}
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
                        {/* Only offered when there is something to buy. Spends
                            one metered call per availability row, so unlike
                            Search it confirms first and says how many — a wide
                            date window could otherwise cost 25 calls on one
                            click. */}
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
                        {/* Edit carries the same weight as Search: same size,
                            same fill, same labelled shape, and only the colour
                            saying what each is for. Correcting a window you got
                            wrong is as much a part of running a route as
                            searching it. A neutral tint rather than a solid
                            fill, so "equal" doesn't mean two shouting buttons.

                            Remove used to sit here as a third. It moved to the
                            rail (`RouteNav`), as a 14px icon on the row it acts
                            on: it could only ever remove the route already open,
                            so a labelled button in the editor's header spent
                            header weight on the one action you would want to
                            take WITHOUT opening a route first.

                            Everything the spec beside this button states is
                            editable from Edit — the row is that form, read-only,
                            and Edit is where the call cost is quoted. */}
                        <Button
                          size="small"
                          variant="contained"
                          color="inherit"
                          onClick={() => setEditRoute({ route: r })}
                          startIcon={<EditRoundedIcon fontSize="small" />}
                          sx={{
                            color: "text.primary",
                            bgcolor: "background.raised",
                            "&:hover": { bgcolor: (t) => t.spec.selectedIdle },
                          }}
                        >
                          Edit
                        </Button>
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

                  {/* No view toggle: round trip is a PROPERTY of the route, like
                      its cabins or its window. It is stated in the header
                      above and changed in the Edit dialog, and the pane simply
                      shows what the route is. A toggle here would let the reading
                      disagree with the setting, which is the one thing a route's
                      own pane should never do. */}
                  {r.round_trip === 1 ? (
                    <RoundTripTable
                      route={r}
                      finds={routeFinds}
                      nights={nights}
                      onSearch={(id) => search.start(id)}
                      searching={running}
                      showMap={prefs.showMapColumn}
                      onNightsChange={(n) =>
                        // `undefined` for the whole-window default, which the
                        // router drops from the URL — so the default reading has
                        // no params, and a shared link only carries a trip
                        // length when somebody chose one.
                        setSearch({ minNights: n?.[0], maxNights: n?.[1] }, true)
                      }
                    />
                  ) : (
                    <>
                      {routeFinds.length > 0 ? (
                        // No wrapper. The table IS the editor's content, so it
                        // runs to both edges under the header's rule — a card
                        // around it would put a second border a pixel inside the
                        // pane and a margin outside that.
                        //
                        // Paged in the browser: the dashboard payload carries
                        // every find for every route, and a wide window can hold
                        // hundreds — enough that mounting them all made opening
                        // the route visibly slow.
                        <FindsTable
                          finds={routeFinds}
                          paginate
                          showMap={prefs.showMapColumn}
                        />
                      ) : null}
                      {/* Empty only when there is NOTHING — no direct find and no
                          journey. A route whose pair nobody sells has no direct
                          finds by definition, so gating on those alone printed
                          "no award space" directly above several hundred priced
                          journeys. */}
                      {routeFinds.length === 0 &&
                      (journeysByRoute.get(r.id)?.journeys.length ?? 0) === 0 ? (
                        // "Nobody has looked" and "looked, found nothing" are the two
                        // answers this app exists to keep apart, so the empty state
                        // has to say which one it is.
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
                      {/* UNDER the direct finds, never instead of them: a journey
                          is two award bookings joined at read time, which is a
                          weaker answer than one seat somebody is selling and must
                          not displace it. Renders nothing when nothing stitches. */}
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

      <Dialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove route?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Remove the saved search{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {confirmDel?.origin}&nbsp;{confirmDel && directionArrow(confirmDel)}&nbsp;{confirmDel?.destination}
            </Box>{" "}
            ({confirmDel?.date_start} … {confirmDel?.date_end})? Its stored finds stay in the
            database.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmDel(null)} color="inherit">
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            startIcon={<DeleteOutlineRoundedIcon />}
            disabled={del.isPending}
            onClick={() => confirmDel && del.mutate(confirmDel.id)}
          >
            {del.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Search fires on click; this asks first, because it spends a metered
          call PER ROW and the number is not obvious from the button. Stating the
          cost against the remaining allowance is the whole content — there is no
          budget guard anywhere in this app, so an informed press is the only
          thing standing between a wide route and a quarter of the day. */}
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

      {/* Mounted BEFORE `CallDialog`, which is the drill-down opened from inside
          it and has to stack on top. */}
      <SearchCallsDialog
        run={callsFor == null ? undefined : search.runs[callsFor]}
        onOpenCall={setOpenCall}
        onClose={() => setCallsFor(null)}
      />

      <CallDialog call={openCall} onClose={() => setOpenCall(null)} />

      {/* No global snackbar: a search failure belongs ON the route it failed
          for, not floating at the bottom of the page detached from it. See
          SearchProgress. */}
    </Box>
  );
}
