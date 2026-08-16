import { useCallback } from "react";
import {
  Box,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { AirportMultiAutocomplete } from "../../components/AirportAutocomplete";
import { BookableCurrencies, CabinChip, CurrencyIcon } from "../../components/brand";
import { CURRENCY_LABEL } from "../../lib/currencies";
import { SWITCH_ROW_ML } from "../../lib/layout";
import { MAX_DESTINATIONS, MAX_ORIGINS } from "../../api";
import { CABIN_OPTIONS, FILTER_CURRENCIES } from "./constants";
import { estimateCalls } from "./estimate";
import { ALERT_TYPES, ALERT_TYPE_HELP, ALERT_TYPE_LABEL } from "./alertCopy";
import { usDate } from "./dates";
import type { RouteField, RouteForm } from "./form";
import type { AlertType } from "../../api";

/**
 * Everything about a route, as fields.
 *
 * ONE definition, rendered by two surfaces: the Add dialog and the selected
 * route's header in edit mode. That is the point — a setting expressible on only
 * one of them is either a choice you make once and can never revise, or a
 * revision you can never make in the first place, and both have happened here
 * (cabins and cards were creatable-only for as long as the header was read-only).
 * Adding a field to a route now means adding it here, once.
 */
export function RouteFormFields({
  form,
  setForm,
  focus,
}: {
  form: RouteForm;
  setForm: React.Dispatch<React.SetStateAction<RouteForm>>;
  /** Land on this field when the form opens. See `RouteField`. */
  focus?: RouteField;
}) {
  const estimate = estimateCalls(form, form.dateStart, form.dateEnd, form.roundTrip);

  // ONE ref serves every field, and it hangs off each control's ROOT rather
  // than its input, because the three shapes on this form focus differently: a
  // TextField has an `<input>`, a `select` TextField's real focus target is the
  // display node beside a hidden input, and a Switch's is a checkbox. One query
  // over the root covers all three without three special cases — and the root
  // is also the thing worth scrolling to, since the label and helper text are
  // what tell you where you have landed.
  //
  // A callback ref rather than an effect: the Dialog unmounts its children when
  // it closes, so this fires exactly once per open, after the node exists.
  const focusRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const target =
      node.querySelector<HTMLElement>(
        'input:not([type="hidden"]), [role="combobox"], .MuiSelect-select, textarea',
      ) ?? node;
    target.focus();
    node.scrollIntoView({ block: "center" });
  }, []);
  // The alerts sub-fields are only rendered while alerts are on, and the only
  // thing that can name one is the header's chip — which only exists while they
  // are on. An unrendered target is therefore unreachable, and if it ever does
  // happen it is a no-op: the ref is simply never attached.
  const focusOn = (field: RouteField) => (focus === field ? focusRef : undefined);

  return (
    <>
      <Box
        sx={{
          display: "grid",
          // One column on a phone. Two 131px columns is what `1fr 1fr` came to
          // inside a 390px dialog, and these are not small fields: the origin and
          // destination autocompletes hold a chip per airport, and the cabin and
          // currency selects render chip lists too.
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
          gap: 2,
          pt: 1,
        }}
      >
        <AirportMultiAutocomplete
          label="Origin"
          max={MAX_ORIGINS}
          value={form.origins}
          onChange={(codes) => setForm({ ...form, origins: codes })}
          placeholder="SEA"
          helperText={form.origins.length > 1 ? `${form.origins.length} airports` : undefined}
          rootRef={focusOn("origins")}
        />
        <AirportMultiAutocomplete
          label="Destination"
          max={MAX_DESTINATIONS}
          value={form.destinations}
          onChange={(codes) => setForm({ ...form, destinations: codes })}
          placeholder="NRT"
          helperText={
            form.destinations.length > 1 ? `${form.destinations.length} airports` : undefined
          }
          rootRef={focusOn("destinations")}
        />
        <TextField
          label="From"
          type="date"
          size="small"
          required
          fullWidth
          ref={focusOn("dateStart")}
          value={form.dateStart}
          onChange={(e) => setForm({ ...form, dateStart: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="To"
          type="date"
          size="small"
          required
          fullWidth
          ref={focusOn("dateEnd")}
          value={form.dateEnd}
          onChange={(e) => setForm({ ...form, dateEnd: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Cabin"
          select
          size="small"
          fullWidth
          ref={focusOn("cabins")}
          value={form.cabins}
          onChange={(e) =>
            setForm({
              ...form,
              cabins:
                typeof e.target.value === "string"
                  ? e.target.value.split(",")
                  : (e.target.value as unknown as string[]),
            })
          }
          helperText="Which cabins to monitor. Empty = any."
          slotProps={{
            inputLabel: { shrink: true },
            select: {
              multiple: true,
              displayEmpty: true,
              renderValue: (selected) => {
                const codes = selected as string[];
                if (codes.length === 0)
                  return (
                    <Typography component="span" variant="body2" color="text.secondary">
                      Any cabin
                    </Typography>
                  );
                return (
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
                    {codes.map((c) => (
                      <CabinChip key={c} cabin={c} />
                    ))}
                  </Stack>
                );
              },
            },
          }}
        >
          {CABIN_OPTIONS.map((c) => (
            <MenuItem key={c} value={c} sx={{ textTransform: "capitalize" }}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Book with"
          select
          size="small"
          fullWidth
          ref={focusOn("currencies")}
          value={form.currencies}
          onChange={(e) =>
            setForm({
              ...form,
              currencies:
                typeof e.target.value === "string"
                  ? e.target.value.split(",")
                  : (e.target.value as unknown as string[]),
            })
          }
          helperText="Only space bookable with these. Empty = any card."
          slotProps={{
            inputLabel: { shrink: true },
            select: {
              multiple: true,
              displayEmpty: true,
              renderValue: (selected) => {
                const codes = selected as string[];
                if (codes.length === 0)
                  return (
                    <Typography component="span" variant="body2" color="text.secondary">
                      Any card
                    </Typography>
                  );
                return (
                  <Stack
                    direction="row"
                    spacing={0.5}
                    useFlexGap
                    sx={{ flexWrap: "wrap", alignItems: "center" }}
                  >
                    {codes.map((c) => (
                      <CurrencyIcon key={c} code={c} size={20} />
                    ))}
                  </Stack>
                );
              },
            },
          }}
        >
          {/* The icon carries the value everywhere else, but a MENU has to stay
              readable cold — you pick from a list of names, not of logos — so
              this is the one currency surface that keeps its label. */}
          {FILTER_CURRENCIES.map((c) => (
            <MenuItem key={c} value={c}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <CurrencyIcon code={c} size={20} />
                <span>{CURRENCY_LABEL[c] ?? c}</span>
              </Stack>
            </MenuItem>
          ))}
        </TextField>

        <TextField
          label="Seats"
          select
          size="small"
          fullWidth
          ref={focusOn("minSeats")}
          value={form.minSeats}
          onChange={(e) => setForm({ ...form, minSeats: Number(e.target.value) })}
          helperText="Hide space for fewer travellers"
          slotProps={{ inputLabel: { shrink: true } }}
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <MenuItem key={n} value={n}>
              {n} seat{n === 1 ? "" : "s"} or more
            </MenuItem>
          ))}
        </TextField>
        {/* `alignSelf: start` plus the input's own height, so the switch centres
            on the Seats FIELD beside it and not on that field plus its helper
            text — centring in the grid cell sits it visibly low. */}
        <Box sx={{ alignSelf: "start", height: 40, display: "flex", alignItems: "center" }}>
          <FormControlLabel
            sx={{ ml: SWITCH_ROW_ML }}
            ref={focusOn("directOnly")}
            control={
              <Switch
                size="small"
                checked={form.directOnly}
                onChange={(e) => setForm({ ...form, directOnly: e.target.checked })}
              />
            }
            label={
              <Typography variant="body2">
                Nonstop only
              </Typography>
            }
          />
        </Box>

        {/* The one setting on this form that changes what is GATHERED rather
            than what is shown, so it says so. Everything above narrows the
            pane and can be undone for free; this one decides what the next
            search asks seats.aero for, and until that search runs the return
            direction does not exist to be filtered. */}
        <Box sx={{ gridColumn: "1 / -1" }}>
          <FormControlLabel
            sx={{ ml: SWITCH_ROW_ML }}
            ref={focusOn("roundTrip")}
            control={
              <Switch
                size="small"
                checked={form.roundTrip}
                onChange={(e) => setForm({ ...form, roundTrip: e.target.checked })}
                // The label below is a Box of two Typographies, which gives the
                // input no usable accessible name — name it explicitly.
                slotProps={{ input: { "aria-label": "Round trip" } }}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Round trip — watch both directions</Typography>
              </Box>
            }
          />
        </Box>

        {/* Alerts. The SECOND setting on this form that changes what is
            GATHERED, and the only one that spends metered calls with nobody
            watching — so it sits below a rule, says what it costs, and defaults
            off. See docs/ALERTS.md. */}
        <Box sx={{ gridColumn: "1 / -1", borderTop: 1, borderColor: "divider", pt: 1.5 }}>
          <FormControlLabel
            sx={{ ml: SWITCH_ROW_ML }}
            ref={focusOn("alertsEnabled")}
            control={
              <Switch
                size="small"
                checked={form.alertsEnabled}
                onChange={(e) => setForm({ ...form, alertsEnabled: e.target.checked })}
                slotProps={{ input: { "aria-label": "Email me about this route" } }}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Email me when this route changes</Typography>
                <Typography variant="caption" color="text.secondary">
                  Re-searched automatically. If this route has not been searched
                  in the last day the first sweep is silent, establishing a
                  baseline to compare against; otherwise the existing results are
                  the baseline and the next sweep can email straight away.
                </Typography>
              </Box>
            }
          />
        </Box>

        {form.alertsEnabled && (
          <>
            <TextField
              label="Tell me about"
              select
              size="small"
              fullWidth
              ref={focusOn("alertOn")}
              value={form.alertOn}
              onChange={(e) =>
                setForm({
                  ...form,
                  alertOn: (typeof e.target.value === "string"
                    ? e.target.value.split(",")
                    : (e.target.value as unknown as string[])) as AlertType[],
                })
              }
              error={form.alertOn.length === 0}
              helperText={
                form.alertOn.length === 0
                  ? "Pick at least one, or nothing will ever be sent."
                  : "Which changes are worth an email."
              }
              slotProps={{
                inputLabel: { shrink: true },
                select: {
                  multiple: true,
                  displayEmpty: true,
                  renderValue: (selected) => {
                    const codes = selected as AlertType[];
                    if (codes.length === 0)
                      return (
                        <Typography component="span" variant="body2" color="error">
                          Nothing selected
                        </Typography>
                      );
                    return codes.map((t) => ALERT_TYPE_LABEL[t]).join(", ");
                  },
                },
              }}
            >
              {ALERT_TYPES.map((t) => (
                <MenuItem key={t} value={t}>
                  <Box>
                    <Typography variant="body2">{ALERT_TYPE_LABEL[t]}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {ALERT_TYPE_HELP[t]}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </TextField>

            <TextField
              label="Ignore drops under"
              select
              size="small"
              fullWidth
              ref={focusOn("alertMinDropPct")}
              value={form.alertMinDropPct}
              onChange={(e) => setForm({ ...form, alertMinDropPct: Number(e.target.value) })}
              helperText="Award prices wobble; small moves are noise."
              slotProps={{ inputLabel: { shrink: true } }}
            >
              {[0, 5, 10, 15, 20, 25, 50].map((n) => (
                <MenuItem key={n} value={n}>
                  {n === 0 ? "Any drop" : `${n}%`}
                </MenuItem>
              ))}
            </TextField>

            <Box sx={{ gridColumn: "1 / -1" }}>
              <TextField
                label="Send to"
                size="small"
                fullWidth
                type="email"
                ref={focusOn("alertEmail")}
                value={form.alertEmail}
                onChange={(e) => setForm({ ...form, alertEmail: e.target.value })}
                placeholder="the account address"
                helperText="Leave empty to use the account address. Must be an allowed recipient."
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Box>
          </>
        )}
      </Box>
    </>
  );
}
