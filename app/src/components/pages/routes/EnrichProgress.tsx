import { Box, Button, CircularProgress, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import type { EnrichState } from "./useRouteEnrich";

/**
 * "Enrich all" progress, in one line.
 *
 * Much thinner than `SearchProgress` on purpose. A search's panel exists because
 * a refused chunk and an empty chunk are indistinguishable in the finds table,
 * so a gap has to be shown somewhere. Enrichment has no such ambiguity — every
 * row it touches was already found — so what is worth saying is the count, the
 * calls spent, and the two things that would otherwise silently overstate
 * success: rows the cap left behind, and rows seats.aero had no itinerary for.
 */
export function EnrichProgress({ run, onDismiss }: { run: EnrichState; onDismiss?: () => void }) {
  return (
    // Same band treatment as `SearchProgress` above — see the note there.
    <Box
      sx={(t) => ({
        position: "relative",
        p: 1.25,
        pr: onDismiss ? 4 : 1.25,
        bgcolor: t.palette.background.chrome,
        borderBottom: `1px solid ${t.palette.divider}`,
      })}
    >
      {onDismiss && (
        <Tooltip title="Dismiss">
          <IconButton
            size="small"
            onClick={onDismiss}
            sx={{ position: "absolute", top: 2, right: 2, color: "text.disabled" }}
          >
            <CloseRoundedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {run.status === "running" && <CircularProgress size={14} />}
        <Typography variant="caption" color="text.secondary">
          {run.status === "running"
            ? `Fetching itineraries · ${run.done}/${run.targets}`
            : `Fetched ${run.enriched} itinerar${run.enriched === 1 ? "y" : "ies"} in ${
                run.done
              } call${run.done === 1 ? "" : "s"}`}
          {run.empty > 0 &&
            ` · ${run.empty} had no itinerary at the stored price and stay summaries`}
          {run.failed > 0 && ` · ${run.failed} failed`}
          {/* Never left implicit: without this the run reads as "all done". */}
          {run.status === "done" &&
            run.capped &&
            run.left > 0 &&
            ` · ${run.left} more left — run it again for those`}
          {run.remainingQuota != null &&
            ` · ${run.remainingQuota.toLocaleString()} calls left today`}
        </Typography>
      </Stack>
      {run.error && (
        <Typography variant="caption" color="error.main">
          {run.error}
        </Typography>
      )}
    </Box>
  );
}
