import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { api } from "../../api";
import { RouteFormFields } from "./RouteFormFields";
import { defaultRouteForm, formFromRoute, routeFormIncomplete, type EditTarget, type RouteForm } from "./form";
import { useIsPhone } from "../../hooks/useBreakpoints";

/**
 * The header's spec, opened up as a form. Reached from the pencil beside
 * Search, and the twin of `AddRouteDialog` down to the fields inside it.
 *
 * A dialog, not an inline mode: ten fields and a cost estimate is a page's
 * worth of controls, and unfolding all of it above the finds table pushed the
 * results off screen and left the pane hard to read at a glance. The header
 * stays a two-tier summary; editing borrows the screen and gives it back.
 *
 * The edit itself destroys nothing: narrowing a window stops finds from joining,
 * widening it back shows them again, and the stored snapshots never notice
 * either way. What it *does* do is search — a window you have just moved has
 * dates nobody has ever looked at, and an unsearched date and an empty one are
 * the two answers this app exists to keep apart. So Save is not confirmed
 * (nothing is at risk) but it is labelled with what it spends.
 *
 * Hence TWO submits, and the plain one is not a lesser copy of the other. Most
 * edits move nothing that was never looked at — renaming a route, narrowing it
 * to business, raising `min_seats` — and those are pure display changes over
 * data already in D1, so spending a handful of metered calls to re-learn what is
 * already stored is waste. **Save** is for those; **Save & search** is for the
 * edits that widen the window, add an airport, or turn on `round_trip`, where
 * the new spec asks a question nobody has run. The dialog can't tell which one
 * you just made — `AddRouteDialog` has no such choice, because a brand-new route
 * has always moved onto unsearched dates.
 */
export function EditRouteDialog({
  target,
  onClose,
  onSaved,
}: {
  /** The route being edited and, when the header sent you here by clicking one
   *  of its values, which field to land on. */
  target: EditTarget | null;
  onClose: () => void;
  /** The saved route's id — the page searches it. */
  onSaved: (id: number) => void;
}) {
  const qc = useQueryClient();
  const route = target?.route ?? null;
  const phone = useIsPhone();
  const [form, setForm] = useState<RouteForm>(defaultRouteForm);

  // Seed from whichever route is being edited. Keyed on the id rather than the
  // object: the page refetches for reasons of its own (a search finishing
  // under this route), and re-seeding on a new object identity would throw away
  // half-typed edits every time one landed.
  useEffect(() => {
    if (route) setForm(formFromRoute(route));
  }, [route?.id]);

  // Ask the route graph what hubs it would pick, and put them in the form. A
  // mutation rather than a query because it is an ACT — you press a button and
  // something changes on screen — even though the request itself writes nothing.
  const suggestVia = useMutation({
    mutationFn: () => api.suggestRoutePaths(route!.id),
    onSuccess: ({ via }) => setForm((f) => ({ ...f, via })),
  });

  // The mutation variable is "…and then search it": one write path, so the two
  // buttons cannot drift on what they save, only on what happens after.
  const save = useMutation<unknown, Error, boolean>({
    mutationFn: () =>
      api.updateTrackedRoute(route!.id, {
        origins: form.origins,
        destinations: form.destinations,
        // A GATHERING setting, and this handler enumerates every field it sends —
        // omitted here it would silently never save.
        via: form.via,
        dateStart: form.dateStart,
        dateEnd: form.dateEnd,
        cabins: form.cabins,
        currencies: form.currencies,
        minSeats: form.minSeats,
        directOnly: form.directOnly,
        // `null` when the field is empty, which is what CLEARS the ceiling —
        // omitting it would keep the stored one and make the field one-way.
        pointLimit: form.pointLimit,
        roundTrip: form.roundTrip,
        alertsEnabled: form.alertsEnabled,
        // Empty string means "use the account address", which on the wire is
        // null — the column's own convention.
        alertEmail: form.alertEmail.trim() || null,
        alertOn: form.alertOn,
        alertMinDropPct: form.alertMinDropPct,
      }),
    onSuccess: (_data, thenSearch) => {
      // Read off the closure, not off the prop at call time: `onClose` clears
      // the parent's `editRoute` before this line would be re-evaluated.
      const id = route!.id;
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      onClose();
      // A plain save needs nothing further: the dialog is only ever opened on the
      // selected route, and the invalidations above already redraw its pane with
      // the new spec. The invalidations are what makes it honest — a narrowed
      // route hides stored finds the moment the page refetches.
      if (thenSearch) onSaved(id);
    },
  });

  return (
    // Full screen on a phone, for the same reason as the add dialog: a long form
    // whose Save button must not be below the fold.
    <Dialog open={!!route} onClose={onClose} maxWidth="sm" fullWidth fullScreen={phone}>
      <Box
        component="form"
        // Enter in a text field submits the form, and the form's action is the
        // cheap one — a keystroke should never be what spends the quota.
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(false);
        }}
      >
        <DialogTitle>Edit route</DialogTitle>
        <DialogContent>
          <RouteFormFields
            form={form}
            setForm={setForm}
            focus={target?.focus}
            // Fills the field; Save is what commits. So asking what the graph
            // thinks is free and reversible, which it would not be if the
            // endpoint wrote — and this is the only way to re-rank a route that
            // already has hubs, since PATCH deliberately keeps those.
            onSuggestVia={route ? () => void suggestVia.mutate() : undefined}
            suggestingVia={suggestVia.isPending}
          />
          {suggestVia.isSuccess && suggestVia.data.via.length === 0 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Every fetched program is monitored on this pair already, or none of them reaches it
              with a stop. Either way there is nothing to add.
            </Alert>
          )}
          {save.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              Could not save: {String(save.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} color="inherit" disabled={save.isPending}>
            Cancel
          </Button>
          {/* Outlined beside contained: the same write, and only the one on the
              right spends. `save.variables` is which button is in flight, so the
              pending label lands on the button that was actually pressed. */}
          <Button
            type="submit"
            variant="outlined"
            disabled={save.isPending || routeFormIncomplete(form)}
          >
            {save.isPending && save.variables === false ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="contained"
            onClick={() => save.mutate(true)}
            disabled={save.isPending || routeFormIncomplete(form)}
          >
            {save.isPending && save.variables === true ? "Saving…" : "Save & search"}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
