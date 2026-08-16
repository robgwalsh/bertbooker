import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  InputAdornment,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Paper,
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
import { alpha, useTheme } from "@mui/material/styles";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import ClearRoundedIcon from "@mui/icons-material/ClearRounded";
import { api, type AirportInfo, type AirportSearchOpts } from "../api";
import { AirportMap } from "../AirportMap";
import { countryName, flagEmoji, TYPE_LABEL } from "../ui";
import { readable } from "../theme";

// Debounce a rapidly-changing value (search box) to limit backend calls.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const TYPE_ORDER = [
  "large_airport",
  "medium_airport",
  "small_airport",
  "heliport",
  "seaplane_base",
  "balloonport",
];

const CONTINENTS = [
  { code: "AF", label: "Africa" },
  { code: "AS", label: "Asia" },
  { code: "EU", label: "Europe" },
  { code: "NA", label: "North America" },
  { code: "SA", label: "South America" },
  { code: "OC", label: "Oceania" },
  { code: "AN", label: "Antarctica" },
];

const RESULT_LIMIT = 100;

function TypeChip({ type }: { type: string }) {
  const theme = useTheme();
  const known = TYPE_LABEL[type];
  const label = known?.label ?? type.replace(/_/g, " ");
  // An unknown airport type has no colour of its own; the old slate-grey literal
  // was legible only on the near-black theme it was written against.
  const color = readable(known?.color ?? theme.palette.text.secondary, theme);
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.3)}`,
      }}
    />
  );
}

// A chip that toggles a boolean filter on/off.
function ToggleChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Chip
      label={label}
      onClick={onToggle}
      variant={active ? "filled" : "outlined"}
      color={active ? "primary" : "default"}
      sx={{ fontWeight: 600 }}
    />
  );
}

export function Airports() {
  const [input, setInput] = useState("");
  const q = useDebounced(input.trim(), 250);
  const [types, setTypes] = useState<string[]>([]);
  const [continent, setContinent] = useState("");
  const [country, setCountry] = useState("");
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const [iataOnly, setIataOnly] = useState(false);

  const { data: countries = [] } = useQuery({
    queryKey: ["airport-countries"],
    queryFn: api.airportCountries,
    staleTime: Infinity,
  });
  const countryOptions = useMemo(
    () =>
      [...countries].sort((a, b) =>
        countryName(a.country).localeCompare(countryName(b.country)),
      ),
    [countries],
  );
  const selectedCountry = countryOptions.find((c) => c.country === country) ?? null;

  const activeFilters =
    types.length + (continent ? 1 : 0) + (country ? 1 : 0) + (scheduledOnly ? 1 : 0) + (iataOnly ? 1 : 0);
  const isDefault = !q && activeFilters === 0;

  // One set of criteria drives both views: the table lists the top matches, the
  // map plots the whole matching set (its own, much larger server-side cap).
  // Untouched, they diverge on purpose — the table shows major airports, the map
  // shows the whole world (the API applies the majors default only to the table).
  const criteria: AirportSearchOpts = {
    types,
    continent,
    country,
    scheduled: scheduledOnly,
    iataOnly,
  };
  const searchKey = [q, types, continent, country, scheduledOnly, iataOnly];

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["airports", ...searchKey],
    queryFn: () => api.airports(q, { ...criteria, limit: RESULT_LIMIT }),
    placeholderData: (prev) => prev,
  });

  // Airport data is static reference data, so every result set caches forever —
  // notably the unfiltered ~72k-row world dump, fetched once per session.
  const { data: geo, isFetching: geoFetching } = useQuery({
    queryKey: ["airports-geo", ...searchKey],
    queryFn: () => api.airportsGeo(q, criteria),
    placeholderData: (prev) => prev,
    staleTime: Infinity,
  });

  const clearAll = () => {
    setTypes([]);
    setContinent("");
    setCountry("");
    setScheduledOnly(false);
    setIataOnly(false);
  };
  const rows = data ?? [];

  return (
    <Stack spacing={3}>
      <Box>
        {/* h5 to match the Library's other panes — this renders as a tab there,
            not as a page of its own. */}
        <Typography variant="h5" gutterBottom>
          Airports
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Search {countries.length ? "the worldwide airport database" : "airports"} by IATA/ICAO
          code, name, city, or country — combine words and filters to narrow. The map plots
          every match; the table lists the top ones.
        </Typography>
      </Box>

      <TextField
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Try “london heathrow”, “new york jfk”, or “KLAX”"
        fullWidth
        autoFocus
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon sx={{ color: "text.secondary" }} />
              </InputAdornment>
            ),
            endAdornment: isFetching ? (
              <InputAdornment position="end">
                <CircularProgress size={18} />
              </InputAdornment>
            ) : null,
          },
        }}
      />

      {/* Filters */}
      <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel>Type</InputLabel>
          <Select
            multiple
            value={types}
            onChange={(e) => setTypes(typeof e.target.value === "string" ? [e.target.value] : e.target.value)}
            input={<OutlinedInput label="Type" />}
            renderValue={(sel) => `${sel.length} selected`}
          >
            {TYPE_ORDER.map((t) => (
              <MenuItem key={t} value={t}>
                <Checkbox checked={types.includes(t)} size="small" />
                <ListItemText primary={TYPE_LABEL[t]?.label ?? t} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Continent</InputLabel>
          <Select
            value={continent}
            onChange={(e) => setContinent(e.target.value)}
            input={<OutlinedInput label="Continent" />}
          >
            <MenuItem value="">
              <em>Any</em>
            </MenuItem>
            {CONTINENTS.map((c) => (
              <MenuItem key={c.code} value={c.code}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Autocomplete
          size="small"
          sx={{ minWidth: 240 }}
          options={countryOptions}
          value={selectedCountry}
          onChange={(_, next) => setCountry(next?.country ?? "")}
          getOptionLabel={(o) => countryName(o.country) || o.country}
          isOptionEqualToValue={(o, v) => o.country === v.country}
          renderOption={(props, o) => (
            <Box component="li" {...props} key={o.country}>
              <Box component="span" sx={{ fontSize: 18, mr: 1 }}>
                {flagEmoji(o.country)}
              </Box>
              {countryName(o.country) || o.country}
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: "auto", pl: 1 }}>
                {o.count}
              </Typography>
            </Box>
          )}
          renderInput={(params) => <TextField {...params} label="Country" />}
        />

        <ToggleChip
          label="Scheduled service"
          active={scheduledOnly}
          onToggle={() => setScheduledOnly((v) => !v)}
        />
        <ToggleChip label="Has IATA" active={iataOnly} onToggle={() => setIataOnly((v) => !v)} />

        {activeFilters > 0 && (
          <Button size="small" color="inherit" startIcon={<ClearRoundedIcon />} onClick={clearAll}>
            Clear filters
          </Button>
        )}
      </Stack>

      <Stack spacing={1}>
        <AirportMap
          airports={geo ?? []}
          // Null on the default view: keep the framed world shot rather than
          // fitting bounds to every airport on Earth.
          fitKey={isDefault ? null : JSON.stringify(searchKey)}
          loading={geoFetching}
          height="min(52vh, 520px)"
        />
        <Typography variant="caption" color="text.secondary">
          {!geo
            ? "Loading map…"
            : `${geo.length.toLocaleString()} airport${geo.length === 1 ? "" : "s"} plotted${
                isDefault ? " — search or filter to narrow the map" : ""
              } — zoom in or click a cluster to expand.`}
        </Typography>
      </Stack>

      {error ? (
        <Alert severity="error">Failed to load airports: {String(error)}</Alert>
      ) : isLoading ? (
        <Stack sx={{ py: 8, alignItems: "center" }}>
          <CircularProgress />
        </Stack>
      ) : rows.length === 0 ? (
        <Typography color="text.secondary" variant="body2">
          No airports match your search.
        </Typography>
      ) : (
        <>
          <Typography variant="overline" color="text.secondary">
            {isDefault
              ? "Major airports"
              : rows.length >= RESULT_LIMIT
                ? `First ${RESULT_LIMIT} results — refine to narrow`
                : `${rows.length} result${rows.length === 1 ? "" : "s"}`}
          </Typography>
          <TableContainer component={Paper} elevation={0}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>IATA</TableCell>
                  <TableCell>ICAO</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>City</TableCell>
                  <TableCell>Country</TableCell>
                  <TableCell>Type</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((a: AirportInfo) => (
                  <TableRow key={a.ident} hover sx={{ "&:last-child td": { border: 0 } }}>
                    <TableCell>
                      {a.iata ? (
                        <Chip
                          size="small"
                          label={a.iata}
                          sx={{
                            fontWeight: 700,
                            letterSpacing: "0.06em",
                            color: "secondary.main",
                            bgcolor: (t) => t.spec.accentMuted,
                          }}
                        />
                      ) : (
                        <Typography component="span" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ letterSpacing: "0.04em" }}>
                        {a.icao || "—"}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                    <TableCell>{a.city || "—"}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                        <Box component="span" sx={{ fontSize: 18, lineHeight: 1 }}>
                          {flagEmoji(a.country)}
                        </Box>
                        <span>{countryName(a.country) || a.country || "—"}</span>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <TypeChip type={a.type} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <Typography variant="caption" color="text.secondary">
        Data: OurAirports (public domain).
      </Typography>
    </Stack>
  );
}
