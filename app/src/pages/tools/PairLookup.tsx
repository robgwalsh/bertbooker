import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import { api } from "../../api";
import type { PairProgram } from "../../api";
import { AirportAutocomplete } from "../../components/AirportAutocomplete";
import { CurrencyIcons } from "../../components/TransferCurrencies";
import { SectionHeader } from "../../components/SectionHeader";
import { miles } from "../../lib/format";

/**
 * Who flies this pair?
 *
 * The question the route graph uniquely answers, and the one that only works
 * because the cache spans programs — asking it live would be one metered call
 * per program, every time.
 *
 * Both directions are shown separately. A program flying SFO→NRT is not evidence
 * that it flies NRT→SFO, and a round-trip route needs both.
 */
export function PairLookup() {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const ready = origin.length === 3 && destination.length === 3;

  const { data, isFetching, error } = useQuery({
    queryKey: ["route-graph", "pair", origin, destination],
    queryFn: () => api.routeGraphPair(origin, destination),
    enabled: ready,
    placeholderData: (prev) => prev,
  });

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
          Pick two airports to see which programs are monitored on that pair.
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
              {isFetching ? " · updating…" : ""}
            </Typography>
          )}

          <Direction
            label={`${data.origin} → ${data.destination}`}
            programs={data.forward}
            known={data.fetchedSources.length > 0}
          />
          <Direction
            label={`${data.destination} → ${data.origin}`}
            programs={data.reverse}
            known={data.fetchedSources.length > 0}
          />
        </Stack>
      )}
    </Box>
  );
}

function Direction({
  label,
  programs,
  known,
}: {
  label: string;
  programs: PairProgram[];
  known: boolean;
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
    </Box>
  );
}
