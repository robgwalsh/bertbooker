import { useEffect, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { parseCodeList, parseCodes } from "../../../lib/routeShape";
import { miles } from "../../../lib/format";
import { RouteDiagram } from "./RouteDiagram";
import { RouteFilters } from "./RouteFilters";
import { estimateCalls } from "./estimate";
import { citySideLabel, dayCount, directionArrow, searchedHelp, searchedLabel } from "./labels";
import { usDate } from "./dates";
import type { RouteCount } from "./RouteNav";
import type { AirportName, TrackedRoute } from "../../../api/index";

/**
 * The removal confirmation, opened from the rail's per-row bin.
 *
 * It is the only undo-less action on the page, and it was one line of text —
 * which made it the sparsest thing in an app that quotes a call cost before
 * spending one. Two questions decide the press and neither was answered here:
 * **which route is this** (the bin is a 14px target on a row you may not have
 * selected, and two SEA→NRT routes differ only by their window and filters), and
 * **what am I losing** (the honest answer is: almost nothing — and saying so is
 * worth more than a warning would be).
 *
 * So it states the route the way the rest of the page does — the same
 * `RouteDiagram` the header draws, the same `RouteFilters` chips the rail
 * carries — and then the consequences, in the order they matter. Stored award
 * space is FIRST because it is the reassuring one: finds are matched to a route
 * by SHAPE at query time (`api/src/db/finds.ts`), never owned by its row, and
 * `DELETE /api/tracked-routes/:id` deletes exactly that row — so re-adding the
 * same pair and window brings every one of them straight back.
 *
 * Nothing here fetches and nothing here spends: the counts, names and alert
 * state are all props the page already holds.
 */
export function RemoveRouteDialog({
  route,
  names,
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The route being removed, or `null` when the dialog is closed. */
  route: TrackedRoute | null;
  /** The page's shared airport lookup, so the diagram here names airports
   *  exactly as the header and the rail do. */
  names: Map<string, AirportName>;
  /** The rail's count for this route, which is round TRIPS on a round-trip
   *  route and finds on a one-way one — see `RouteCount`. */
  count?: RouteCount;
  /** The delete is in flight: the button says so and both buttons lock. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: (id: number) => void;
}) {
  // MUI keeps rendering the children through the close transition, so reading
  // straight off a prop the parent has already cleared would empty the card and
  // then fade the frame around it. Hold the last route through that frame.
  const [shown, setShown] = useState<TrackedRoute | null>(route);
  useEffect(() => {
    if (route) setShown(route);
  }, [route]);
  const r = route ?? shown;

  if (!r) return null;

  const roundTrip = r.round_trip === 1;
  const found = count?.found ?? 0;
  const via = parseCodeList(r.via);
  const cities = [
    ...parseCodes(r.origins, r.origin),
    ...parseCodes(r.destinations, r.destination),
  ].some((c) => names.has(c));
  const days = dayCount(r.date_start, r.date_end);
  // What re-adding it would cost, quoted the way every other spend on this page
  // is: a floor and a ceiling, from the same estimator the add and edit dialogs
  // use. It is the one part of a removal that is genuinely gone — everything
  // else is still in the database afterwards.
  const cost = estimateCalls(
    {
      origins: parseCodes(r.origins, r.origin),
      destinations: parseCodes(r.destinations, r.destination),
    },
    r.date_start,
    r.date_end,
    roundTrip,
  );
  const calls = cost.floor === cost.ceiling ? `${cost.floor}` : `${cost.floor}–${cost.ceiling}`;

  return (
    <Dialog open={!!route} onClose={busy ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
          <DeleteOutlineRoundedIcon fontSize="small" color="error" />
          <span>Remove this route?</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {/* The route, drawn as the page draws it everywhere else. A card on the
            chrome ground rather than a sentence of codes: the bin is reachable
            from any rail row without selecting it, so this may be the first
            close look you get at the route you are about to remove. */}
        <Box
          sx={{
            p: 1.5,
            borderRadius: 1,
            border: "1px solid",
            borderColor: "ruleSoft",
            bgcolor: "background.chrome",
          }}
        >
          <RouteDiagram route={r} names={names} />
          {/* The cities under the codes, exactly as the rail writes them — the
              diagram's pills carry the airports' full names in a tooltip, and a
              dialog you are reading rather than pointing at should not need one.
              Suppressed wholesale until something resolves, or an unresolved
              code would print the code line twice. */}
          {cities && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: "block", mt: 0.5 }}
            >
              {citySideLabel(r.origins, r.origin, names)}
              <Box component="span" sx={{ mx: 0.5 }}>
                {directionArrow(r)}
              </Box>
              {citySideLabel(r.destinations, r.destination, names)}
            </Typography>
          )}
          <Divider sx={{ my: 1.25 }} />
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {usDate(r.date_start)} – {usDate(r.date_end)}
            </Typography>
            <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: "nowrap" }}>
              {days}d
            </Typography>
            {/* The rail's own number, and it counts what the rail counts — a
                round-trip route's chip is PAIRS, not legs. */}
            {found > 0 && (
              <Chip
                size="small"
                variant="outlined"
                color="success"
                label={
                  roundTrip
                    ? `${found} round trip${found === 1 ? "" : "s"}`
                    : `${found} find${found === 1 ? "" : "s"}`
                }
              />
            )}
            {/* Its own chip beside the find count, exactly as in the rail: a
                journey is stitched at read time from OTHER routes' legs, so it
                is not this route's data and removal does not touch it either. */}
            {count?.viaJourneys ? (
              <Chip
                size="small"
                variant="outlined"
                color="secondary"
                label={`${count.viaJourneys} via`}
              />
            ) : null}
            {!r.last_checked_at && (
              <Chip size="small" variant="outlined" color="warning" label="unsearched" />
            )}
            <Tooltip title={searchedHelp(r)}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ ml: "auto", cursor: "help", whiteSpace: "nowrap" }}
              >
                {searchedLabel(r)}
              </Typography>
            </Tooltip>
          </Stack>
          {/* The rail's chip row — cabins, cards, round trip, nonstop — plus the
              three settings it has no room for. Two routes over one pair differ
              HERE, so this is what tells you which of them you have. */}
          <Stack
            direction="row"
            spacing={0.5}
            useFlexGap
            sx={{
              mt: 1,
              alignItems: "center",
              flexWrap: "wrap",
              "& .MuiChip-root": { height: 19, fontSize: 10.5 },
              "& .MuiChip-label": { px: 0.85 },
            }}
          >
            <RouteFilters route={r} />
            {via.length > 0 && (
              <Chip
                size="small"
                variant="outlined"
                color="secondary"
                label={`via ${via.join(", ")}`}
              />
            )}
            {(r.min_seats ?? 1) > 1 && (
              <Chip size="small" variant="outlined" label={`${r.min_seats}+ seats`} />
            )}
            {r.point_limit != null && (
              <Chip size="small" variant="outlined" label={`${miles(r.point_limit)} max`} />
            )}
          </Stack>
        </Box>

        <Stack spacing={1.25} sx={{ mt: 2 }}>          
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {/* Focused, so Enter cancels. The destructive button is the one thing on
            this page that cannot be undone; it should never be what a stray
            keystroke presses. */}
        <Button autoFocus onClick={onCancel} color="inherit" disabled={busy}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          startIcon={<DeleteOutlineRoundedIcon />}
          disabled={busy}
          onClick={() => onConfirm(r.id)}
        >
          {busy ? "Removing…" : "Remove route"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
