import { useEffect } from "react";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { api } from "../../api";
import { RouteFormFields } from "./RouteFormFields";
import { createRouteBody, defaultRouteForm, routeFormIncomplete, type RouteForm } from "./form";

export function AddRouteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The new route's id, the moment the Worker has stored it — the page selects
   *  it and searches it. See `searchAfterSave`. */
  onCreated: (id: number) => void;
}) {
  const qc = useQueryClient();
  const phone = useIsPhone();
  const [form, setForm] = useState(defaultRouteForm);

  // Reset each time the dialog opens (so the default window is anchored to
  // "today", not to whenever the component first mounted).
  //
  useEffect(() => {
    if (open) setForm(defaultRouteForm());
  }, [open]);

  const add = useMutation({
    // NOT `api.addTrackedRoute(form)`. `createRouteBody` omits an empty `via` so
    // the Worker fills the hubs in — see its docblock, and its test.
    mutationFn: () => api.addTrackedRoute(createRouteBody(form)),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      setForm(defaultRouteForm());
      onClose();
      // Last, and after the dialog is out of the way: the search's progress
      // panel belongs on the route's pane, which is what the page navigates to.
      onCreated(id);
    },
  });

  return (
    // Full screen on a phone: this is a long form ending in "Add & search", and
    // MUI's fullScreen dialog is a flex column whose `DialogContent` scrolls, so
    // the actions stay pinned instead of sitting below the fold.
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={phone}>
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <DialogTitle>New monitored route</DialogTitle>
        <DialogContent>
          <RouteFormFields form={form} setForm={setForm} />

          {add.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              Could not add route: {String(add.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} color="inherit">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            startIcon={<AddRoundedIcon />}
            disabled={add.isPending || routeFormIncomplete(form)}
          >
            {add.isPending ? "Adding…" : "Add & search"}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
