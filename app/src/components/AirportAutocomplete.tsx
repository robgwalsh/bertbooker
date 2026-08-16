import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { api, type AirportInfo } from "../api";
import { countryName, flagEmoji } from "../lib/format";
// Shared, so the async lookup fires on pause rather than on every keystroke.
// This used to be a local copy here and an identical one in the Airports pane.
import { useDebounced } from "../hooks/useDebounced";

const optionLabel = (a: AirportInfo) =>
  `${a.iata} · ${a.city || a.name}`;

// Airport picker backed by GET /api/airports (iataOnly). Presents a rich list
// but keeps the external contract as a plain IATA code string, so the route /
// calendar forms and their mutations are unchanged.
export function AirportAutocomplete({
  label,
  value,
  onChange,
  required,
  sx,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  required?: boolean;
  sx?: object;
}) {
  const [selected, setSelected] = useState<AirportInfo | null>(null);
  const [input, setInput] = useState("");
  const q = useDebounced(input.trim(), 250);

  const { data: options = [], isFetching } = useQuery({
    queryKey: ["airport-options", q],
    queryFn: () => api.airports(q, { iataOnly: true, limit: 8 }),
    placeholderData: (prev) => prev,
  });

  // Resolve a preset code (e.g. Calendar's default JFK/DXB) to a full option so
  // the selected label renders on mount. Guard against clobbering user picks.
  const resolvedFor = useRef<string | null>(null);
  useEffect(() => {
    const code = value.trim().toUpperCase();
    if (!code) {
      setSelected(null);
      resolvedFor.current = null;
      return;
    }
    if (selected?.iata === code || resolvedFor.current === code) return;
    resolvedFor.current = code;
    let cancelled = false;
    api
      .airports(code, { iataOnly: true, limit: 5 })
      .then((list) => {
        if (cancelled) return;
        const match = list.find((a) => a.iata?.toUpperCase() === code) ?? null;
        if (match) setSelected(match);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // Releasing the latch matters as much as cancelling. StrictMode runs every
      // effect twice in dev — mount, clean up, mount again — so without this the
      // first pass claims the code, its result is thrown away as cancelled, and
      // the second pass sees the code already claimed and returns early. The
      // preset then never resolves and the box stays blank forever while its
      // filter is live.
      if (resolvedFor.current === code) resolvedFor.current = null;
    };
  }, [value, selected]);

  // Show the resolved airport in the box.
  //
  // Not redundant with `value={selected}`: `inputValue` is controlled here, and
  // the handler below deliberately ignores MUI's `reset` reason (which would
  // wipe half-typed text on blur) — so a selection arriving from anywhere other
  // than a click left the field looking EMPTY while its filter was live. That
  // is the worst of both: a prefilled route filters the results and the form
  // says nothing is filtered. Typing doesn't change `selected`, so this can't
  // fight the user.
  useEffect(() => {
    if (selected) setInput(optionLabel(selected));
  }, [selected]);

  return (
    <Autocomplete<AirportInfo, false, false, false>
      value={selected}
      onChange={(_, next) => {
        setSelected(next);
        onChange(next?.iata ?? "");
      }}
      inputValue={input}
      onInputChange={(_, next, reason) => {
        if (reason !== "reset") setInput(next);
      }}
      options={options}
      loading={isFetching}
      filterOptions={(x) => x} // server already ranks/filters
      isOptionEqualToValue={(o, v) => o.ident === v.ident}
      getOptionLabel={(o) => (o.iata ? optionLabel(o) : "")}
      noOptionsText={q ? "No airports" : "Type a code, city, or name"}
      sx={sx}
      renderOption={(props, o) => (
        <Box component="li" {...props} key={o.ident}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: "100%" }}>
            <Box component="span" sx={{ fontSize: 18, lineHeight: 1 }}>
              {flagEmoji(o.country)}
            </Box>
            <Typography sx={{ fontWeight: 700, width: 42 }}>{o.iata}</Typography>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {o.city || o.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {o.name}
                {o.country ? ` · ${countryName(o.country)}` : ""}
              </Typography>
            </Box>
          </Stack>
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          size="small"
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              endAdornment: (
                <>
                  {isFetching ? <CircularProgress size={16} /> : null}
                  {params.slotProps.input.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}

/**
 * The same picker, for a SET of airports.
 *
 * A deliberate sibling rather than a `multiple` flag on the one above. That
 * component carries a preset-resolution effect — the machinery that turns a
 * stored `"JFK"` back into a full option so the box isn't blank while its filter
 * is live — and none of it is needed here: chips render the codes directly, so
 * there is nothing to resolve and nothing to keep in sync. Bolting a mode onto
 * it would have meant making that effect conditional in four places for no gain,
 * with four existing single-select call sites to regress.
 *
 * Values in and out are plain uppercase IATA codes, same external contract.
 */
export function AirportMultiAutocomplete({
  label,
  value,
  onChange,
  max,
  placeholder,
  helperText,
  sx,
  rootRef,
}: {
  label: string;
  value: string[];
  onChange: (codes: string[]) => void;
  /** Refuses to add past this. The caps exist because a wide route paginates —
   *  see MAX_ORIGINS in shared/src/routing.ts. */
  max: number;
  placeholder?: string;
  helperText?: string;
  sx?: object;
  /** The Autocomplete's ROOT element, not its input. The route form focuses one
   *  named field on open and scrolls it into view, and it does that from each
   *  control's root so that a text field, a select and a switch are all one
   *  case — see `focusRef` in pages/routes/RoutesPage.tsx. */
  rootRef?: React.Ref<HTMLDivElement>;
}) {
  const [input, setInput] = useState("");
  const q = useDebounced(input.trim(), 250);
  const atMax = value.length >= max;

  const { data: options = [], isFetching } = useQuery({
    queryKey: ["airport-options", q],
    queryFn: () => api.airports(q, { iataOnly: true, limit: 8 }),
    placeholderData: (prev) => prev,
    enabled: !atMax,
  });

  return (
    <Autocomplete<AirportInfo, true, false, false>
      multiple
      ref={rootRef}
      // The chips ARE the value, so nothing needs resolving back to an option.
      value={[]}
      disabled={false}
      onChange={(_, picked) => {
        const code = picked.at(-1)?.iata?.toUpperCase();
        if (!code || value.includes(code) || atMax) return;
        onChange([...value, code]);
        setInput("");
      }}
      inputValue={input}
      onInputChange={(_, next, reason) => {
        if (reason !== "reset") setInput(next);
      }}
      options={atMax ? [] : options}
      loading={isFetching}
      filterOptions={(x) => x}
      isOptionEqualToValue={(o, v) => o.ident === v.ident}
      getOptionLabel={(o) => (o.iata ? optionLabel(o) : "")}
      getOptionDisabled={(o) => Boolean(o.iata && value.includes(o.iata.toUpperCase()))}
      noOptionsText={atMax ? `At most ${max}` : q ? "No airports" : "Type a code, city, or name"}
      sx={sx}
      renderOption={(props, o) => (
        <Box component="li" {...props} key={o.ident}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: "100%" }}>
            <Box component="span" sx={{ fontSize: 18, lineHeight: 1 }}>
              {flagEmoji(o.country)}
            </Box>
            <Typography sx={{ fontWeight: 700, width: 42 }}>{o.iata}</Typography>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {o.city || o.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {o.name}
                {o.country ? ` · ${countryName(o.country)}` : ""}
              </Typography>
            </Box>
          </Stack>
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          size="small"
          placeholder={value.length ? undefined : placeholder}
          helperText={helperText}
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <>
                  {value.map((code) => (
                    <Chip
                      key={code}
                      label={code}
                      size="small"
                      onDelete={() => onChange(value.filter((v) => v !== code))}
                      sx={{ mr: 0.5, fontWeight: 700 }}
                    />
                  ))}
                  {params.slotProps.input.startAdornment}
                </>
              ),
              endAdornment: (
                <>
                  {isFetching ? <CircularProgress size={16} /> : null}
                  {params.slotProps.input.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}
