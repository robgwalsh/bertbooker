import { useEffect, useState } from "react";
import { Alert, Button, Chip, DialogActions } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody, TableCell, TableRow, Tooltip, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { bytesLabel, formatBody, RENDER_LIMIT } from "./callFormat";
import type { SearchCall } from "../../api";

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (!entries.length) {
    return (
      <Typography variant="caption" color="text.secondary">
        none
      </Typography>
    );
  }
  return (
    <Box component="table" sx={{ borderCollapse: "collapse", width: "100%" }}>
      <Box component="tbody">
        {entries.map(([k, v]) => (
          <Box component="tr" key={k}>
            <Box
              component="td"
              sx={{
                pr: 2,
                py: 0.25,
                verticalAlign: "top",
                whiteSpace: "nowrap",
                fontFamily: "monospace",
                fontSize: 12,
                color: "text.secondary",
              }}
            >
              {k}
            </Box>
            <Box
              component="td"
              sx={{
                py: 0.25,
                fontFamily: "monospace",
                fontSize: 12,
                wordBreak: "break-all",
              }}
            >
              {v}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * The full request and response for one seats.aero call.
 *
 * This is the thing that turns "775 offers" into something checkable: when a find
 * looks wrong, or a cabin is missing, the answer is in the payload the parser was
 * handed.
 *
 * The body is session state, streamed alongside the results — it is not stored,
 * and a reload loses it. `search_tasks.capture_json` keeps the metadata.
 */
export function CallDialog({ call, onClose }: { call: SearchCall | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const phone = useIsPhone();
  useEffect(() => setCopied(false), [call]);
  if (!call) return null;

  const formatted = call.body ? formatBody(call.body) : null;
  const rendered = formatted ? formatted.text.slice(0, RENDER_LIMIT) : "";
  const clipped = formatted ? formatted.text.length > RENDER_LIMIT : false;

  return (
    // Full screen on a phone. This one holds a raw request and response, and a
    // modal card with 32px of backdrop either side is the worst possible frame
    // for a wall of JSON.
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth fullScreen={phone}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography component="span" sx={{ fontFamily: "monospace", fontWeight: 700 }}>
            {call.method}
          </Typography>
          <Chip
            size="small"
            color={call.ok ? "success" : "error"}
            variant="outlined"
            label={call.status ?? "no response"}
          />
          <Typography variant="body2" color="text.secondary">
            {call.durationMs} ms · {bytesLabel(call.bytes)}
            {call.rows != null && ` · ${call.rows} rows`}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {call.error && <Alert severity="error">{call.error}</Alert>}

          <Box>
            <Typography variant="overline" color="text.secondary">
              Request
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                mb: 1,
                p: 1,
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                borderRadius: 1,
                bgcolor: (t) => alpha(t.palette.common.black, 0.3),
              }}
            >
              {call.url}
            </Box>
            <HeaderTable headers={call.requestHeaders} />
          </Box>

          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
              <Typography variant="overline" color="text.secondary">
                Response
              </Typography>
              {call.body && (
                <Button
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(call.body!).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy body"}
                </Button>
              )}
            </Stack>
            {call.responseHeaders && <HeaderTable headers={call.responseHeaders} />}

            {call.bodyOmitted ? (
              <Alert severity="info" sx={{ mt: 1 }}>
                The response body wasn't kept — this search had already streamed back its display
                budget. The call itself, its timing and its size are above.
              </Alert>
            ) : formatted ? (
              <>
                {(call.bodyTruncated || clipped) && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    {call.bodyTruncated && "The server sent more than was captured. "}
                    {clipped && `Showing the first ${bytesLabel(RENDER_LIMIT)} of the payload. `}
                    {call.body && "Use Copy body for everything that was captured."}
                  </Alert>
                )}
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    mb: 0,
                    p: 1,
                    fontSize: 12,
                    maxHeight: "50vh",
                    overflow: "auto",
                    borderRadius: 1,
                    bgcolor: (t) => alpha(t.palette.common.black, 0.3),
                  }}
                >
                  {rendered}
                </Box>
              </>
            ) : call.error ? (
              // Careful with the wording: a 401 DID reach seats.aero, it was just
              // refused before its payload was read. Only a sticky refusal (no
              // status at all) never left this machine.
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                {call.status
                  ? "No response body was kept — the call was refused before its payload was read. The error above is what came back."
                  : "Nothing was sent. An earlier call in this search was refused, so the rest stopped asking rather than spending the allowance to be told the same thing."}
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                No response body.
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

