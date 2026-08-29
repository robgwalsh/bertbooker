import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { AirportMultiAutocomplete } from "../../components/AirportAutocomplete";
import { SettingsDialog } from "../../components/SettingsDialog";
import { CabinChip } from "../../components/brand";
import { SWITCH_ROW_ML } from "../../lib/layout";
import { MAX_DESTINATIONS, MAX_ORIGINS, MAX_VIA, api } from "../../api";
import { CABIN_OPTIONS } from "./constants";
import { ALERT_TYPES, ALERT_TYPE_HELP, ALERT_TYPE_LABEL } from "./alertCopy";
import type { RouteField, RouteForm } from "./form";
import type { AlertType } from "../../api";

/**
 * A route's GATHERING spec, as fields.
 *
 * ONE definition, rendered by two surfaces: the Add dialog and the selected
 * route's header in edit mode. Everything here decides what the next search asks
 * seats.aero for, which is why it is worth a dialog and a deliberate Save — the
 * read filters left for the header's chip strip, where they are stated, because
 * they cost nothing and reverse instantly.
 *
 * Cabins is the one read filter that still appears here, and only for the Add
 * dialog: a route being created has no header yet, and the cabins you mean are
 * usually the reason you are creating it.
 */
export function RouteFormFields({
  form,
  setForm,
  focus,
  cabins,
  onCabinsChange,
  onSuggestVia,
  suggestingVia,
}: {
  form: RouteForm;
  setForm: React.Dispatch<React.SetStateAction<RouteForm>>;
  /** Land on this field when the form opens. See `RouteField`. */
  focus?: RouteField;
  /** The cabins a NEW route starts with. Supplied by the ADD dialog only, and
   *  the callback's presence is what renders the field: on a stored route the
   *  header's chip owns cabins, and a second control here would save whatever it
   *  seeded over whatever the chip has since set. */
  cabins?: string[];
  onCabinsChange?: (codes: string[]) => void;
  /** Ask the route graph for hubs and fill the Via field. Supplied by the EDIT
   *  dialog only — a new route has its hubs filled in server-side on save, and
   *  an existing one can otherwise never be re-ranked. */
  onSuggestVia?: () => void;
  suggestingVia?: boolean;
}) {
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
          // destination autocompletes hold a chip per airport, and the cabin
          // select renders a chip list too.
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
        {/* Full width, and only on a one-way route.
            Hidden rather than disabled when Round trip is on, because the
            Worker IGNORES hubs there — a control that is visible, editable and
            has no effect is worse than one that is absent. Left EMPTY on a new
            route on purpose: the Worker fills it in on save when the pair
            reaches nothing directly, so the honest default is "I have not
            worked this out yet" rather than a guess the form cannot make. */}
        {!form.roundTrip && (
          <Box sx={{ gridColumn: "1 / -1" }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <AirportMultiAutocomplete
                  label="Via"
                  max={MAX_VIA}
                  value={form.via}
                  onChange={(codes) => setForm({ ...form, via: codes })}
                  placeholder="ICN"
                  helperText={
                    form.via.length
                      ? "One extra query per date range, on top of the direct one — the hubs, then the hubs onward."
                      : onSuggestVia
                        ? "Hubs to route through. Ask the route graph, or leave empty for none."
                        : "Hubs to route through. Left empty, this is worked out when you save."
                  }
                  rootRef={focusOn("via")}
                />
              </Box>
              {/* Only on an EDIT, and only because that is the one place it is
                  needed: a new route has its hubs filled in on save, while an
                  existing one keeps the hubs somebody chose and can otherwise
                  never be re-ranked when the graph gains a program. Asking
                  writes nothing — it fills the field and Save commits. */}
              {onSuggestVia && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onSuggestVia}
                  disabled={suggestingVia}
                  sx={{ mt: 0.5, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  {suggestingVia ? "Looking…" : "Find paths"}
                </Button>
              )}
            </Stack>
          </Box>
        )}
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
        {onCabinsChange && (
          <TextField
            label="Cabin"
            select
            size="small"
            fullWidth
            value={cabins ?? []}
            onChange={(e) =>
              onCabinsChange(
                typeof e.target.value === "string"
                  ? e.target.value.split(",")
                  : (e.target.value as unknown as string[]),
              )
            }
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
        )}

        {/* Full width: this switch is a one-line yes/no answer with nothing left
            beside it to share a row with. Like Via above it, and unlike the
            cabins field, it decides what the next search asks seats.aero for —
            until that search runs the return direction does not exist to be
            filtered. */}
        <Box
          sx={{
            gridColumn: "1 / -1",
            alignSelf: "start",
            height: 40,
            display: "flex",
            alignItems: "center",
          }}
        >
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
                <Typography variant="body2">Round trip</Typography>
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
              slotProps={{ inputLabel: { shrink: true } }}
            >
              {[0, 5, 10, 15, 20, 25, 50].map((n) => (
                <MenuItem key={n} value={n}>
                  {n === 0 ? "Any drop" : `${n}%`}
                </MenuItem>
              ))}
            </TextField>

            <Box sx={{ gridColumn: "1 / -1" }}>
              <RecipientField
                value={form.alertEmail}
                onChange={(alertEmail) => setForm({ ...form, alertEmail })}
                fieldRef={focusOn("alertEmail")}
              />
            </Box>
          </>
        )}
      </Box>
    </>
  );
}

/**
 * Where this route's digest goes — a Select over the allowlist, not a text box.
 *
 * The allowlist (`alert_recipients`, `docs/ALERTS.md` §9) is what stops one
 * shared password turning this app into an arbitrary-recipient sender on a
 * verified domain. It used to be an env binding nothing in the UI could show,
 * so the only way to discover an address was not on it was a 400 on save. Now
 * the field can only offer addresses the Worker will actually accept, and the
 * server's check is a backstop rather than the first time anyone finds out.
 *
 * `""` still means "the account address", which is the column's own convention
 * (`alert_email` NULL) and what `EditRouteDialog` writes back.
 */
function RecipientField({
  value,
  onChange,
  fieldRef,
}: {
  value: string;
  onChange: (value: string) => void;
  fieldRef: React.Ref<HTMLDivElement> | undefined;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const q = useQuery({ queryKey: ["alert-recipients"], queryFn: api.alertRecipients });

  const allowed = q.data?.recipients.map((r) => r.email) ?? [];
  // A stored address can outlive its place on the list, and the list is not
  // there at all on the first render. Either way a Select whose value is not
  // among its options renders BLANK and warns — which `e2e/fixtures.ts` fails a
  // run on — so the value always gets an option, named for why it is odd.
  const orphaned = value !== "" && !allowed.includes(value);

  return (
    <>
      <TextField
        label="Send to"
        select
        size="small"
        fullWidth
        ref={fieldRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
        helperText={
          <Box component="span">
            Only allowed recipients can be chosen.{" "}
            <Box
              component="span"
              role="button"
              tabIndex={0}
              onClick={() => setManageOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setManageOpen(true);
              }}
              sx={{ cursor: "pointer", textDecoration: "underline", color: "secondary.main" }}
            >
              Manage recipients
            </Box>
          </Box>
        }
      >
        <MenuItem value="">
          The account address
          {q.data?.accountAddress ? ` (${q.data.accountAddress})` : ""}
        </MenuItem>
        {allowed.map((email) => (
          <MenuItem key={email} value={email}>
            {email}
          </MenuItem>
        ))}
        {orphaned && (
          <MenuItem value={value}>
            {value} {q.isPending ? "" : "— no longer allowed"}
          </MenuItem>
        )}
      </TextField>

      {/* Stacked over the route form rather than navigating away from it: adding
          a recipient must not cost a half-filled route. Closing returns here,
          and the mutation has already invalidated `alert-recipients`, so the
          new address is in the list above. */}
      <SettingsDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        initialTab="system"
      />
    </>
  );
}
