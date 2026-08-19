import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import AddRoadRoundedIcon from "@mui/icons-material/AddRoadRounded";
import { api } from "../../api";
import type { GraphPath, PairProgram, PathSearchResult } from "../../api";
import { AirportAutocomplete } from "../../components/AirportAutocomplete";
import { CurrencyIcons } from "../../components/TransferCurrencies";
import { SectionHeader } from "../../components/SectionHeader";
import { miles } from "../../lib/format";
import { defaultRouteWindow } from "../../lib/routeWindow";

/**
 * Who flies this pair — and, when nobody does, how you would still get there.
 *
 * The question the route graph uniquely answers, and the one that only works
 * because the cache spans programs: asking it live would be one metered call per
 * program, every time.
 *
 * Both directions are shown separately. A program flying SFO→NRT is not evidence
 * that it flies NRT→SFO, and a round-trip route needs both.
 *
 * **The connections half is a different kind of claim from the direct half, and
 * the pane has to say so.** seats.aero holds availability per monitored market,
 * so a pair in nobody's graph returns nothing from a search no matter how many
 * hubs join it — the legs are the searchable objects, which is why the only
 * action offered is to track them.
 */
export function PairLookup() {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const ready = origin.length === 3 && destination.length === 3 && origin !== destination;

  const { data, isFetching, error } = useQuery({
    queryKey: ["route-graph", "pair", origin, destination],
    queryFn: () => api.routeGraphPair(origin, destination),
    enabled: ready,
    placeholderData: (prev) => prev,
  });

  // A separate query from the one above, not a wider one: the direct answer is a
  // single indexed lookup and this walks a self-join, so the first result can
  // paint while the second is still running.
  const pathsQ = useQuery({
    queryKey: ["route-graph", "paths", origin, destination],
    queryFn: () => api.routeGraphPaths(origin, destination),
    enabled: ready,
    placeholderData: (prev) => prev,
  });

  // Already cached by the Data coverage tab, and free either way. A path carries
  // bare `programs.code` values; this is what turns them into names and cards.
  const sourcesQ = useQuery({
    queryKey: ["route-graph", "sources"],
    queryFn: api.routeGraphSources,
    staleTime: Infinity,
  });
  const programs = useMemo(() => {
    const out = new Map<string, { label: string; currencies: string[] }>();
    for (const s of sourcesQ.data ?? []) {
      if (s.program && !out.has(s.program)) {
        out.set(s.program, { label: s.label, currencies: s.currencies });
      }
    }
    return out;
  }, [sourcesQ.data]);

  return (
    <Box>
      <SectionHeader
        title="Who flies this pair?"
        icon={<AltRouteRoundedIcon sx={{ color: "secondary.main" }} />}
      />
      {/* `flex: 1` on both, so they split the 640 evenly. Without it each field
          is only as wide as its own content, and "Destination" is long enough
          that its own label clips — which was survivable when this was the third
          section of a Library tab and is not, now that it is the whole page. */}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 2, maxWidth: 640 }}>
        <AirportAutocomplete
          label="Origin"
          value={origin}
          onChange={setOrigin}
          sx={{ flex: 1 }}
        />
        <AirportAutocomplete
          label="Destination"
          value={destination}
          onChange={setDestination}
          sx={{ flex: 1 }}
        />
      </Stack>

      {!ready && (
        <Typography variant="body2" color="text.secondary">
          Pick two airports to see which programs are monitored on that pair, and how to
          reach it with a stop when none is.
        </Typography>
      )}

      {error && <Alert severity="error">Lookup failed: {String(error)}</Alert>}

      {ready && data && (
        <Stack spacing={2}>
          {!data.fetchedSources.length ? (
            // Without this the two empty lists below would read as "nobody flies
            // it", which is a completely different claim from "we have not
            // asked anybody".
            <Alert severity="info">
              No source has been fetched yet, so there is nothing to answer with. Fetch a program
              on the Data coverage tab first.
            </Alert>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Across {data.fetchedSources.length} fetched{" "}
              {data.fetchedSources.length === 1 ? "source" : "sources"}
              {isFetching || pathsQ.isFetching ? " · updating…" : ""}
            </Typography>
          )}

          <Direction
            label={`${data.origin} → ${data.destination}`}
            programs={data.forward}
            known={data.fetchedSources.length > 0}
            paths={pathsQ.data?.forward}
            programInfo={programs}
          />
          <Direction
            label={`${data.destination} → ${data.origin}`}
            programs={data.reverse}
            known={data.fetchedSources.length > 0}
            paths={pathsQ.data?.reverse}
            programInfo={programs}
          />
        </Stack>
      )}
    </Box>
  );
}

type ProgramInfoMap = Map<string, { label: string; currencies: string[] }>;

function Direction({
  label,
  programs,
  known,
  paths,
  programInfo,
}: {
  label: string;
  programs: PairProgram[];
  known: boolean;
  paths: PathSearchResult | undefined;
  programInfo: ProgramInfoMap;
}) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {label}
      </Typography>
      {!programs.length ? (
        <Typography variant="body2" color="text.secondary">
          {known ? "No fetched program is monitored on this pair." : "Not known yet."}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {programs.map((p) => (
            <Stack
              key={p.source}
              direction="row"
              spacing={1.5}
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Typography variant="body2" sx={{ minWidth: 180 }}>
                {p.label}
              </Typography>
              {p.program ? (
                <CurrencyIcons codes={p.currencies} />
              ) : (
                // Real reach this app cannot book. Worth showing rather than
                // hiding — it is the answer to "is there ANY award space here".
                <Chip
                  size="small"
                  label="not bookable from here"
                  sx={{
                    bgcolor: (t) => alpha(t.palette.text.secondary, 0.12),
                    color: "text.secondary",
                  }}
                />
              )}
              {p.distance_mi ? (
                <Typography variant="caption" color="text.secondary">
                  {miles(p.distance_mi)}
                </Typography>
              ) : null}
            </Stack>
          ))}
        </Stack>
      )}
      {known && paths ? <Connections result={paths} programInfo={programInfo} /> : null}
    </Box>
  );
}

/**
 * How to get there with a stop.
 *
 * Rendered only when there is something to say. `depth: 0` means a program is
 * monitored on the pair itself and the list above already answered — offering
 * connections there would be answering a question nobody asked.
 */
function Connections({
  result,
  programInfo,
}: {
  result: PathSearchResult;
  programInfo: ProgramInfoMap;
}) {
  if (result.depth === 0) return null;

  if (!result.paths.length) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
        No one- or two-stop path through any fetched program's network either.
      </Typography>
    );
  }

  const stops = result.paths[0]!.via.length;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="secondary.main" sx={{ display: "block", mb: 0.5 }}>
        {stops === 1 ? "One stop" : "Two stops"} — {result.paths.length}{" "}
        {result.paths.length === 1 ? "option" : "options"}
        {result.truncated ? " (more were found than are shown)" : ""}
      </Typography>
      {/* The sentence the whole section turns on. A path is a claim about which
          markets are monitored, chained; searching the pair itself still returns
          nothing, which is why the only button here creates routes. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Each leg is searchable on its own; the pair is not. Track the legs to search them.
      </Typography>
      {/* A GRID on the container rather than a Stack of rows, so the distance,
          the programs and the button line up down the list — a ragged action
          column reads as a list of unrelated things. Each `PathRow` is four
          cells, not a row. On a phone the four wrap into two lines of two,
          which needs no DOM change and so no breakpoint hook. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr auto",
            sm: "max-content max-content max-content max-content",
          },
          // `max-content` on the grid itself, so it takes only the width its
          // columns need instead of throwing the action column at the far edge
          // of a 1440px pane. The same trick the coverage table uses, and with
          // the same trap: a `minWidth: 100%` here would silently defeat it.
          width: { sm: "max-content" },
          maxWidth: "100%",
          alignItems: "center",
          columnGap: 1.5,
          rowGap: 1,
        }}
      >
        {result.paths.map((path, i) => (
          <PathRow key={path.via.join(">")} path={path} programInfo={programInfo} index={i} />
        ))}
      </Box>
    </Box>
  );
}

function PathRow({
  path,
  programInfo,
  index,
}: {
  path: GraphPath;
  programInfo: ProgramInfoMap;
  index: number;
}) {
  const queryClient = useQueryClient();
  const track = useMutation({
    mutationKey: ["route-graph", "track-legs"],
    mutationFn: async () => {
      // One route per leg, in order, because that is what the legs ARE: two
      // separately searchable pairs. Sequential rather than parallel so a
      // failure half way leaves a comprehensible state rather than a race.
      for (const leg of path.legs) {
        await api.addTrackedRoute({
          origins: [leg.origin],
          destinations: [leg.destination],
          ...defaultRouteWindow(),
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tracked-routes"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      // The reach panel's verdicts are about these very pairs.
      await queryClient.invalidateQueries({ queryKey: ["route-graph", "reach"] });
    },
  });

  const chain = [path.legs[0]?.origin, ...path.via, path.legs[path.legs.length - 1]?.destination];

  // A path is TWO grid rows on a phone and one everywhere else, so below `sm`
  // the groups run together without a rule to tell them apart. Not on the first
  // one, which would draw a line immediately under the heading above it.
  const groupRule = index
    ? { borderTop: { xs: 1, sm: 0 }, borderColor: "divider", pt: { xs: 1, sm: 0 } }
    : {};

  return (
    <>
      <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums", ...groupRule }}>
        {chain.join(" → ")}
      </Typography>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ justifySelf: "end", whiteSpace: "nowrap", ...groupRule }}
      >
        {path.totalMi !== null ? miles(path.totalMi) : "distance unknown"}
        {path.detour !== null ? ` · +${Math.round((path.detour - 1) * 100)}%` : ""}
      </Typography>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {path.mixed ? (
          // A materially weaker claim than a one-program path, and never shown as
          // equivalent: one award per leg, two currencies, and the connection is
          // the traveller's own risk.
          <Chip
            size="small"
            label="needs two awards"
            sx={{
              bgcolor: (t) => alpha(t.palette.warning.main, 0.14),
              color: "warning.main",
              border: (t) => `1px solid ${alpha(t.palette.warning.main, 0.35)}`,
            }}
          />
        ) : (
          <PathPrograms path={path} programInfo={programInfo} />
        )}
        {track.error ? (
          <Typography variant="caption" color="error.main">
            {String(track.error)}
          </Typography>
        ) : null}
      </Stack>

      <Button
        size="small"
        variant="outlined"
        startIcon={<AddRoadRoundedIcon />}
        disabled={track.isPending || track.isSuccess}
        onClick={() => track.mutate()}
        sx={{ justifySelf: "end", whiteSpace: "nowrap" }}
      >
        {track.isSuccess ? "Tracked" : track.isPending ? "Adding…" : "Track these legs"}
      </Button>
    </>
  );
}

/** The programs whose own network covers every leg — the reason this path is one
 *  award rather than two. Falls back to naming unmapped sources, which is real
 *  reach this app cannot book and is worth seeing rather than hiding. */
function PathPrograms({ path, programInfo }: { path: GraphPath; programInfo: ProgramInfoMap }) {
  if (!path.programs.length) {
    return (
      <Chip
        size="small"
        label={`${path.unmappedSources.join(", ")} · not bookable from here`}
        sx={{
          bgcolor: (t) => alpha(t.palette.text.secondary, 0.12),
          color: "text.secondary",
        }}
      />
    );
  }
  const currencies = [
    ...new Set(path.programs.flatMap((code) => programInfo.get(code)?.currencies ?? [])),
  ];
  const labels = path.programs.map((code) => programInfo.get(code)?.label ?? code);
  return (
    <>
      <Typography variant="caption" color="text.secondary">
        {labels.join(", ")}
      </Typography>
      <CurrencyIcons codes={currencies} />
    </>
  );
}
