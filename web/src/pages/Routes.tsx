import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { RoutesSearchParams } from "../router";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItemButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import NotificationsNoneRoundedIcon from "@mui/icons-material/NotificationsNoneRounded";
import {
  ALERT_TYPES,
  api,
  ENRICH_MAX_PER_RUN,
  type AirportName,
  type AlertScheduleRoute,
  type AlertType,
  type Find,
  type SearchCall,
  type TrackedRoute,
} from "../api";
import { FindsTable } from "../FindsTable";
import { RoundTripTable } from "../RoundTripTable";
import { parseCodeList, parseCodes } from "../routeShape";
import { useAirportNames } from "../useAirportNames";
import { useRouteSearch, type ChunkState, type RunState } from "../useRouteSearch";
import { useRouteEnrich, type EnrichState } from "../useRouteEnrich";
import {
  BookableCurrencies,
  CabinChip,
  CurrencyIcon,
  CURRENCY_LABEL,
  PagePad,
  sinceLabel,
  SWITCH_ROW_ML,
  useIsNarrow,
  useIsPhone,
} from "../ui";
import { ALERT_HEALTH, alertHealth, formatInterval } from "../alerts";
import { usePreferences } from "../preferences";
import { AirportMultiAutocomplete } from "../AirportAutocomplete";

// Cabin options for a route's cabin filter. No "any" sentinel — an empty
// selection means "any cabin" (stored as NULL server-side).
const CABIN_OPTIONS = ["economy", "premium", "business", "first"];

// The couple's transfer currencies, in display order — the options for a route's
// currency filter. (Excludes "direct": PointsYeah results are only ever tagged
// bookable with one of these four transfer partners.)
const FILTER_CURRENCIES = ["chase_ur", "capital_one", "bilt", "citi_ty"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Format an ISO date (YYYY-MM-DD) as American M/D/YYYY. Parsed from the parts
// directly so the calendar day is never shifted by the local timezone.
function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(m)}/${Number(d)}/${y}`;
}

// Fresh add-route form: default the search window to the next year (today →
// +12 months), which is roughly how far out award calendars publish.
/**
 * Route-planning constants, hand-mirrored from `packages/core/src/routing.ts`
 * and `providers/seatsaero.ts`.
 *
 * Copied rather than imported because the SPA has no `@bertbooker/core` dependency —
 * core references `D1Database` at module scope and fights a DOM tsconfig, which
 * is the same reason `web/src/api.ts` mirrors every wire type by hand. The
 * server validates independently and answers 400 `bad_route_spec`, so these only
 * stop the form offering something that would be refused, and only the estimate
 * would go stale if they drifted.
 */
/** The widest the route rail is allowed to get. It sizes to its content below
 *  this — see the grid that lays out the two panes. */
const RAIL_MAX_WIDTH = 320;

/** The header diagram's reserved width — a constant, not a measurement, so the
 *  spec and the action buttons beside it don't move when you select a route
 *  with a different number of airports. Holds `SEA/PDX ⇄ NRT/HND` on one line. */
const ROUTE_DIAGRAM_WIDTH = 248;

const MAX_ORIGINS = 3;
const MAX_DESTINATIONS = 3;
const SEATSAERO_CHUNK_DAYS = 90;
const SEATSAERO_MAX_CHUNKS = 5;
const SEATSAERO_MAX_PAGES = 10;

/** One side of a route: `SEA` or `SEA/PDX`. Falls back to the scalar, which for
 *  a route carrying no array IS the whole set. */
function sideLabel(json: string | null, fallback: string): string {
  if (json) {
    try {
      const codes = JSON.parse(json);
      if (Array.isArray(codes) && codes.length) return codes.join("/");
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

interface RouteShape {
  origins: string[];
  destinations: string[];
}

/**
 * What pressing Search will spend, as a range.
 *
 * The headline is that pairs are nearly free: seats.aero takes comma-delimited
 * airports, so a whole cross product is one call and only the number of date
 * chunks adds any. Quoted as floor..ceiling because the true figure depends on
 * how many rows the window holds, which is the thing a search finds out.
 */
function estimateCalls(
  form: RouteShape,
  dateStart: string,
  dateEnd: string,
  roundTrip = false,
) {
  const days =
    Math.round(
      (Date.parse(`${dateEnd}T00:00:00`) - Date.parse(`${dateStart}T00:00:00`)) / 86_400_000,
    ) + 1;
  const chunks = Math.max(
    1,
    Math.min(SEATSAERO_MAX_CHUNKS, Math.ceil((Number.isFinite(days) ? days : 1) / SEATSAERO_CHUNK_DAYS)),
  );
  // Round trip unions the two sides, so the pair count is the square of the
  // combined set minus its self-pairs — and the CALL count is untouched, which
  // is the headline. Mirrors `estimateSearchCalls`/`roundTripSpec` in
  // packages/core/src/routing.ts.
  const pairs = roundTrip
    ? (() => {
        const both = new Set([...form.origins, ...form.destinations]);
        return both.size * both.size - both.size;
      })()
    : form.origins.length * form.destinations.length;
  return { pairs, chunks, floor: chunks, ceiling: chunks * SEATSAERO_MAX_PAGES };
}

/**
 * The route form's state — one shape for creating and for editing.
 *
 * Deliberately not `TrackedRoute`: that is the stored row, with JSON-string
 * columns and legacy scalars beside the arrays that supersede them. This is what
 * a person is choosing, and `formFromRoute` is the one place the two meet.
 */
interface RouteForm {
  origins: string[];
  destinations: string[];
  dateStart: string;
  dateEnd: string;
  cabins: string[];
  currencies: string[];
  minSeats: number;
  directOnly: boolean;
  /** Watch both directions. One of the two fields on this form that change what
   *  is GATHERED rather than what is shown. */
  roundTrip: boolean;
  /** The other one: enroll this route in the cron sweep. See docs/ALERTS.md. */
  alertsEnabled: boolean;
  /** Empty = the account's own address. */
  alertEmail: string;
  /** Which transitions email. Never empty while alerts are on — the API refuses
   *  it, because "armed and permanently silent" looks exactly like broken. */
  alertOn: AlertType[];
  alertMinDropPct: number;
}

/**
 * One field of the route form, by name — what the header's values point at.
 *
 * Every value in the header IS a field of this form, so reading the header and
 * then hunting for the matching control in a dialog of thirteen is a step the
 * app can just take for you. The keys are `RouteForm`'s own, so a field renamed
 * there fails to compile here rather than quietly pointing at nothing.
 */
type RouteField = keyof RouteForm;

/** The route the edit dialog is open on, and which of its fields to land on. */
interface EditTarget {
  route: TrackedRoute;
  /** Absent when the dialog was opened from the Edit button — no field is
   *  more relevant than any other there, so nothing is focused and MUI's own
   *  initial focus applies. */
  focus?: RouteField;
}

function defaultRouteForm(): RouteForm {
  const start = new Date();
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1);
  return {
    // Airport SETS, not scalars: one route can watch SEA/PDX -> NRT/HND, because
    // seats.aero takes comma-delimited airports and covers the whole cross
    // product in one call.
    origins: [] as string[],
    destinations: [] as string[],
    dateStart: isoDate(start),
    dateEnd: isoDate(end),
    // Empty = every cabin. The default USED to be business-only, which quietly
    // hid economy space the route had already paid to find: gathering is wide
    // and unfiltered, so a cabin filter here only decides what you are shown.
    // Narrowing is one click; noticing that you never saw it is not.
    cabins: [] as string[],
    currencies: [] as string[], // empty = any card the couple holds
    minSeats: 2,
    directOnly: false,
    roundTrip: false,
    // Off by default: it is the one setting here that spends metered calls
    // without anyone pressing anything.
    alertsEnabled: false,
    alertEmail: "",
    alertOn: ["new", "price_drop"],
    alertMinDropPct: 5,
  };
}

/** A stored route back into the form that edits it. */
function formFromRoute(r: TrackedRoute): RouteForm {
  return {
    origins: parseCodes(r.origins, r.origin),
    destinations: parseCodes(r.destinations, r.destination),
    dateStart: r.date_start,
    dateEnd: r.date_end,
    cabins: parseCodeList(r.cabins),
    currencies: parseCodeList(r.currencies),
    minSeats: r.min_seats ?? 2,
    directOnly: Boolean(r.direct_only),
    roundTrip: Boolean(r.round_trip),
    alertsEnabled: Boolean(r.alerts_enabled),
    alertEmail: r.alert_email ?? "",
    // NULL means the default set, which is what the form must show — an empty
    // multi-select would read as "nothing selected" for a route that in fact
    // alerts on the defaults.
    alertOn: parseAlertOn(r.alert_on),
    alertMinDropPct: r.alert_min_drop_pct ?? 5,
  };
}

/** A stored `alert_on` back into the form's list. Mirrors `parseAlertTypes` in
 *  packages/core/src/alerts/select.ts — NULL and anything unrecognised mean the
 *  default set, never "nothing". */
function parseAlertOn(json: string | null): AlertType[] {
  if (!json) return ["new", "price_drop"];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return ["new", "price_drop"];
    const kept = parsed.filter((t): t is AlertType =>
      (ALERT_TYPES as readonly string[]).includes(String(t)),
    );
    return kept.length ? kept : ["new", "price_drop"];
  } catch {
    return ["new", "price_drop"];
  }
}

/**
 * What each chunk status means to a person reading the panel.
 *
 * The distinction this table encodes is the one the whole architecture is built
 * around: `empty` is an answer ("nobody is selling award space on these dates"),
 * everything below it is the absence of an answer. They produce identical
 * results and must never read alike, because only `empty` licenses believing it.
 * Mirrors `SourceTaskStatus` in packages/core/src/ingest/types.ts.
 */
const CHUNK_STATUS: Record<
  ChunkState["status"],
  { icon: "pending" | "running" | "ok" | "bad"; label: string; help?: string }
> = {
  pending: { icon: "pending", label: "queued" },
  running: { icon: "running", label: "searching…" },
  skipped: { icon: "pending", label: "skipped", help: "Never attempted." },
  ok: { icon: "ok", label: "" },
  empty: { icon: "ok", label: "no award space", help: "Looked, and there is genuinely nothing." },
  failed: { icon: "bad", label: "failed", help: "No answer — not the same as no space." },
  blocked: {
    icon: "bad",
    label: "refused",
    help: "seats.aero refused the call (bad or exhausted key). Nothing was learned about these dates.",
  },
  challenged: { icon: "bad", label: "challenged", help: "No answer — not the same as no space." },
  timeout: { icon: "bad", label: "timed out", help: "No answer — not the same as no space." },
};

function ChunkIcon({ kind }: { kind: "pending" | "running" | "ok" | "bad" }) {
  const sx = { fontSize: 16 };
  if (kind === "running") return <CircularProgress size={14} />;
  if (kind === "ok") return <CheckCircleOutlineRoundedIcon color="success" sx={sx} />;
  if (kind === "bad") return <ErrorOutlineRoundedIcon color="error" sx={sx} />;
  return <RadioButtonUncheckedRoundedIcon sx={{ ...sx, color: "text.disabled" }} />;
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The query string alone. The host and path are the same on every call, so
 *  showing them in the list is noise — the modal has the full URL. */
function callSummary(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(q + 1);
}

/** Pretty-print JSON when it's small enough to be worth the work and the DOM can
 *  take it. A megabyte of indented text will hang the tab, so past the threshold
 *  the raw body is shown as it arrived. */
const PRETTY_LIMIT = 512_000;
/** Hard cap on what goes into the DOM. The full body is still one click away on
 *  the copy button — this only bounds what is *rendered*. */
const RENDER_LIMIT = 400_000;

function formatBody(body: string): { text: string; pretty: boolean } {
  if (body.length <= PRETTY_LIMIT) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), pretty: true };
    } catch {
      /* not JSON — fall through and show it raw */
    }
  }
  return { text: body, pretty: false };
}

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
 * handed, and it used to be unreachable without re-running the call by hand.
 *
 * The body is session state, streamed alongside the results — it is not stored,
 * and a reload loses it. `search_tasks.capture_json` keeps the metadata.
 */
function CallDialog({ call, onClose }: { call: SearchCall | null; onClose: () => void }) {
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

/** One clickable line per HTTP call: what was asked, how it went, how long. */
function CallRow({ call, onOpen }: { call: SearchCall; onOpen: () => void }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      onClick={onOpen}
      sx={{
        alignItems: "center",
        cursor: "pointer",
        borderRadius: 0.5,
        px: 0.5,
        ml: 3,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Chip
        size="small"
        variant="outlined"
        color={call.ok ? "default" : "error"}
        label={call.status ?? "—"}
        sx={{ height: 18, fontSize: 10, "& .MuiChip-label": { px: 0.75 } }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {callSummary(call.url)}
      </Typography>
      <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
        {call.durationMs} ms
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
        {bytesLabel(call.bytes)}
        {call.rows != null && ` · ${call.rows} rows`}
      </Typography>
    </Stack>
  );
}

/**
 * A search in progress, chunk by chunk.
 *
 * Session-scoped and deliberately transient: every finding it reports is already
 * in the database by the time its line appears, so this is a diagnostic for the
 * run you just triggered, not a record of anything. The one thing it must do
 * faithfully is show a refused or failed chunk as a *gap*, since the finds table
 * below cannot — an absent row looks the same either way.
 */
function SearchProgress({
  run,
  onOpenCall,
  onDismiss,
}: {
  run: RunState;
  onOpenCall: (call: SearchCall) => void;
  /** Absent while the run is still going — see `dismiss` in `useRouteSearch`. */
  onDismiss?: () => void;
}) {
  const done = run.chunks.filter((c) => c.status !== "pending" && c.status !== "running").length;

  return (
    // A full-bleed strip between the header and the table, not a card between
    // them: the pane is a stack of bands separated by rules, so this one takes
    // its own rule and gives up its margin and its corners.
    <Box
      sx={(t) => ({
        // The chrome ground, the same one the sidebar and the table heads use:
        // this strip is frame around the pane's work, not more of the work. It
        // was `tint(t, 0.03)` — a 3% wash of white, which is a grey on every
        // palette and therefore looked identical in all of them.
        bgcolor: t.palette.background.chrome,
        borderBottom: `1px solid ${t.palette.divider}`,
      })}
    >
      {/* A header, so the panel says what it is before it says how it went —
          the rows below are timings and ranges, which read as a log of
          something unnamed. It also gives the dismiss control somewhere
          visible to sit. */}
      <Stack
        direction="row"
        spacing={1}
        sx={(t) => ({
          alignItems: "center",
          pl: 1.25,
          pr: 0.5,
          py: 0.25,
          minHeight: 30,
          // A control strip inside the strip, so it takes the palette's own
          // "raised" ground rather than another wash of the same white.
          bgcolor: t.palette.background.raised,
          borderBottom: `1px solid ${t.palette.divider}`,
        })}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {run.status === "running"
            ? "Searching…"
            : run.status === "error"
              ? "Search failed"
              : "Search complete"}
        </Typography>
        {/* Only once the run has settled. Closing it discards nothing: every
            finding it reports was written to D1 as it landed, and a failed
            chunk it reported as a gap is still a gap in the finds below.
            Absent mid-run, when the panel is the only thing saying work is
            happening. */}
        {onDismiss && (
          <Tooltip title="Dismiss">
            <IconButton size="small" onClick={onDismiss} sx={{ color: "text.secondary" }}>
              <CloseRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      <Stack spacing={0.5} sx={{ p: 1.25 }}>
        {run.chunks.map((c, i) => {
          const meta = CHUNK_STATUS[c.status];
          const detail =
            c.status === "ok"
              ? `${c.offersFound ?? 0} offer${c.offersFound === 1 ? "" : "s"}${
                  c.snapshotsWritten ? ` · ${c.snapshotsWritten} changed` : ""
                }`
              : meta.label;
          return (
            <Box key={i}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <ChunkIcon kind={meta.icon} />
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {usDate(c.start)} – {usDate(c.end)}
                </Typography>
                <Tooltip title={c.error ?? meta.help ?? ""}>
                  <Typography
                    variant="caption"
                    color={meta.icon === "bad" ? "error.main" : "text.secondary"}
                  >
                    {detail}
                  </Typography>
                </Tooltip>
                {c.note && (
                  // A narrowed claim is not a failure, but it IS a partial answer,
                  // and it is the only place the far end of the window silently
                  // goes missing.
                  <Tooltip title={c.note}>
                    <Chip size="small" variant="outlined" color="warning" label="partial" />
                  </Tooltip>
                )}
              </Stack>
              {/* The calls that produced the line above. Indented under it,
                  because "which of the three calls was slow" is a question about
                  this range, not about the search. */}
              {c.httpCalls.map((call) => (
                <CallRow key={call.index} call={call} onOpen={() => onOpenCall(call)} />
              ))}
            </Box>
          );
        })}

        {/* Suppressed when the search never got started (a 503 for a missing key,
            say): "0 API calls used" beside the real reason is just noise. */}
        {run.chunks.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
            {run.status === "running"
              ? `${done}/${run.chunks.length} ranges · ${run.calls} API call${run.calls === 1 ? "" : "s"} used`
              : `${run.calls} API call${run.calls === 1 ? "" : "s"} used`}
            {run.remaining != null &&
              ` · ${run.remaining.toLocaleString()}${
                run.limit ? `/${run.limit.toLocaleString()}` : ""
              } left today`}
            {run.runStatus === "partial" &&
              " · some ranges were never checked — the results below are incomplete"}
          </Typography>
        )}

        {run.error && (
          <Typography variant="caption" color="error.main">
            {run.error}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

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
function EnrichProgress({ run, onDismiss }: { run: EnrichState; onDismiss?: () => void }) {
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

function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ mb: 2, alignItems: "center" }}>
      <Typography variant="h5">{title}</Typography>
      {count != null && (
        <Chip size="small" label={count} sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }} />
      )}
      {action && <Box sx={{ ml: "auto" }}>{action}</Box>}
    </Stack>
  );
}

/** A route the form cannot yet submit. Shared, so the Add dialog and the edit
 *  dialog cannot disagree about what a complete route is. */
function routeFormIncomplete(form: RouteForm): boolean {
  return (
    form.origins.length === 0 ||
    form.destinations.length === 0 ||
    form.dateEnd < form.dateStart ||
    // The API refuses this with a 400, and rightly: a route with alerts on and
    // no transitions chosen is armed and permanently silent, which reads exactly
    // like a broken feature. Catch it here so the button is disabled rather than
    // the save failing.
    (form.alertsEnabled && form.alertOn.length === 0)
  );
}

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
function RouteFormFields({
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

const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  new: "New space",
  price_drop: "Cheaper",
  more_seats: "More seats",
  gone: "Gone",
};

/**
 * What each transition actually means, because two of them are easy to misread.
 *
 * `more_seats` carries the first-match-wins caveat: `diffAvailability` checks
 * seats before price, so a drop that coincides with a seat increase is
 * classified `more_seats` and a route watching only `price_drop` never hears
 * about it. Documented here rather than fixed, because changing the classifier
 * would change `changes_json` for the alert sweep too — pinned by a test in
 * packages/core/src/alerts/alerts.test.ts.
 */
const ALERT_TYPE_HELP: Record<AlertType, string> = {
  new: "Award space that wasn't there before",
  price_drop: "The same seat got cheaper",
  more_seats: "Seat count rose — also covers a drop that came with extra seats",
  gone: "Space that disappeared. Often just cache churn",
};

/** What an alert route watches, for the header's chip: `New space · Cheaper`.
 *  Read off the STORED column, not off the schedule — the schedule only lists
 *  routes that are enrolled, and it can still be in flight. */
function alertOnLabel(route: TrackedRoute): string {
  return parseAlertOn(route.alert_on)
    .map((t) => ALERT_TYPE_LABEL[t])
    .join(" · ");
}

const ALERTS_OFF_HELP =
  "This route is not enrolled in the scheduled sweep. Turn alerts on and it is re-searched on a cadence and emails you when something changes — the one setting here that spends metered calls with nobody watching.";

/**
 * The alerts chip's tooltip: what fires, where it goes, and how it is doing.
 *
 * The health sentence and the cadence come from `AlertSchedule`, which is why
 * both are conditional — the shell's poll may not have landed, and a route
 * whose alerts were just turned on has no row there until it refetches. What
 * the route is CONFIGURED to do is always available, so that half never blinks.
 */
function alertHelp(
  route: TrackedRoute,
  alert: AlertScheduleRoute | undefined,
  intervalMinutes: number | null | undefined,
): string {
  const watching = parseAlertOn(route.alert_on)
    .map((t) => ALERT_TYPE_LABEL[t].toLowerCase())
    .join(", ");
  const drop = route.alert_min_drop_pct
    ? `Price drops under ${route.alert_min_drop_pct}% are ignored.`
    : "Any price drop counts.";
  const to = `Sent to ${route.alert_email || "the account address"}.`;
  const last = `Last emailed ${sinceLabel(route.alert_last_digest_at)}.`;
  const cadence = intervalMinutes ? ` Swept ${formatInterval(intervalMinutes)}.` : "";
  const state = alert ? ` ${ALERT_HEALTH[alertHealth(alert)].help}` : "";
  return `Emails you about ${watching}. ${drop} ${to} ${last}${cadence}${state}`;
}

function AddRouteDialog({
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
    mutationFn: () => api.addTrackedRoute(form),
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

/** "San Francisco International Airport · San Francisco, US", as much of it as
 *  we actually know. */
function airportLine(a: AirportName | undefined, code: string): string {
  if (!a) return code;
  const where = [a.city, a.country].filter(Boolean).join(", ");
  return where ? `${a.name} · ${where}` : a.name;
}

/** The city behind a code, for the rail's one-line `Seattle/Portland → Tokyo`.
 *  Falls back to the code, which is never wrong — an unknown code is one the
 *  airports table has no row for. */
function cityLabel(a: AirportName | undefined, code: string): string {
  return a?.city || a?.name || code;
}

/**
 * A route's stored filters as chips: which cabins it watches, and which cards it
 * will accept space for.
 *
 * Rail-only now — the detail header states the same two facts along its one
 * row. Freed of that second caller, these shrink: four of
 * them at full size was the tallest thing in a rail card and the least urgent.
 * `& .MuiChip-root` scales the shared `CabinChip` down here without touching how
 * it renders elsewhere; `BookableCurrencies` takes an explicit `size` instead,
 * since an icon has no label to shrink.
 */
function RouteFilters({ route }: { route: TrackedRoute }) {
  const cabins = parseCodeList(route.cabins);
  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flexWrap: "wrap",
        alignItems: "center",
        "& .MuiChip-root": { height: 19, fontSize: 10.5 },
        "& .MuiChip-label": { px: 0.85 },
      }}
    >
      {cabins.length > 0 ? (
        cabins.map((c) => <CabinChip key={c} cabin={c} />)
      ) : (
        <Chip size="small" variant="outlined" label="Any cabin" />
      )}
      {parseCodeList(route.currencies).length > 0 && (
        <BookableCurrencies
          json={route.currencies ?? undefined}
          size={17}
          note="only showing space bookable with this"
        />
      )}
      {/* Same rule as the nonstop chip: only when it is on. Worth a chip at all
          because it is the one setting here that changed what was FETCHED, so
          two routes over the same pair can legitimately hold different data. */}
      {route.round_trip === 1 && (
        <Tooltip title="Both directions are searched for this route">
          <Chip size="small" variant="outlined" color="primary" label="Round trip" />
        </Tooltip>
      )}
      {/* Only when it is ON. An "any routing" chip on every unfiltered route
          would be four-fifths of the rail saying nothing. */}
      {Boolean(route.direct_only) && (
        <Tooltip title="Only nonstop finds are shown under this route">
          <Chip size="small" variant="outlined" color="info" label="Nonstop" />
        </Tooltip>
      )}
    </Stack>
  );
}

/** Inclusive day count of a route's window, for the header's "365 days". */
function dayCount(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) + 1 : 0;
}

/**
 * One airport of a route's spec, as a pill.
 *
 * A pill each rather than the rail's `SEA/PDX` string, because in the header
 * these are the things you PICKED — separable and individually nameable. The
 * slash form stays in the rail, where the route is a label rather than a spec.
 */
/**
 * One airport in the header diagram: the CODE as plain text, and nothing else.
 *
 * It used to be a chip — tinted background, border — with the full airport name
 * and the city/country stacked underneath. That made the header the busiest
 * thing on the page for information most glances do not need: you know what PIT
 * is, and when you don't, the tooltip still says it in full. So the lookup is
 * not wasted, only quieter — `airportLine` remains the title, and the rail keeps
 * its one-line city subtitle for telling two similar routes apart.
 *
 * The codes carry the emphasis themselves (18px, bold, tracked out), so the
 * chrome was doing nothing the type was not already doing.
 */
function AirportPill({ code, names }: { code: string; names: Map<string, AirportName> }) {
  const airport = names.get(code);

  return (
    <Tooltip title={airportLine(airport, code)} placement="top">
      <Box
        component="span"
        sx={{
          display: "inline-block",
          textAlign: "center",
          fontWeight: 700,
          fontSize: 18,
          letterSpacing: 1,
          lineHeight: 1.35,
          // `inherit`, not `help`: in the header these sit inside a clickable
          // side, and a help cursor over a button says the wrong thing about
          // what a click will do. In the rail there is nothing to inherit from
          // and the default arrow is right.
          cursor: "inherit",
          whiteSpace: "nowrap",
          color: "text.primary",
        }}
      >
        {code}
      </Box>
    </Tooltip>
  );
}

/** The line between two sides of the diagram. Decorative, and deliberately not
 *  proportional to anything — this is a topology sketch, the same rule
 *  `ItineraryCard`'s stop bar follows.
 *
 *  Fixed width, NOT `flex: 1`: the diagram sits in a row that stretches to the
 *  card, so a growing connector drags the destination to the far edge and puts a
 *  metre of empty rule through the middle of the header. */
/** The line between the two sides of the header diagram.
 *
 *  A round trip gets a SECOND plane pointing back, because the route genuinely
 *  watches both directions — one plane would draw a one-way route the app is not
 *  monitoring. Mirrored rather than a `⇄` glyph so it stays the same visual
 *  language as the one-way case. */
function Connector({ roundTrip }: { roundTrip?: boolean }) {
  // One rail width for both cases. It used to be 24 round-trip / 34 one-way,
  // which made the connector — and therefore the whole diagram — 20px narrower
  // for a round trip than a one-way, so selecting a different route in the rail
  // shifted everything to its right. The two-plane stack is the same width as
  // the one-plane one, so a constant rail is a constant connector.
  const rail = {
    width: 30,
    height: 2,
    borderRadius: 1,
    background: (t: Theme) =>
      `linear-gradient(90deg, ${alpha(t.palette.secondary.main, 0.45)}, ${alpha(
        t.spec.success,
        0.45,
      )})`,
  };
  const plane = { fontSize: 14, color: "text.disabled" };
  return (
    <Stack
      direction="row"
      sx={{ alignItems: "center", gap: 0.5, flexShrink: 0 }}
      aria-label={roundTrip ? "round trip" : "one way"}
    >
      <Box sx={rail} />
      <Stack sx={{ alignItems: "center", gap: 0.1 }}>
        <FlightRoundedIcon sx={{ ...plane, transform: "rotate(90deg)" }} />
        {roundTrip && <FlightRoundedIcon sx={{ ...plane, transform: "rotate(-90deg)" }} />}
      </Stack>
      <Box sx={rail} />
    </Stack>
  );
}

/**
 * The route's shape, drawn: origins → destinations.
 *
 * A pill per airport rather than one `SEA/PDX → NRT/HND` string, so each airport
 * the route watches is separately readable and separately nameable.
 */
function RouteDiagram({
  route,
  names,
  onEditSide,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** Each side of the diagram is one field of the route form, so each side is a
   *  shortcut to it. Absent in the rail, where a click selects the route. */
  onEditSide?: (side: "origins" | "destinations") => void;
}) {
  const origins = parseCodes(route.origins, route.origin);
  const destinations = parseCodes(route.destinations, route.destination);

  // No tooltip on the side itself: the pills already carry the airports' full
  // names, and a second tooltip over the top of them would replace the answer
  // you wanted with an instruction you didn't ask for. The pointer and the
  // hover ground say it is clickable instead.
  const side = (codes: string[], which: "origins" | "destinations") => (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      role={onEditSide ? "button" : undefined}
      tabIndex={onEditSide ? 0 : undefined}
      aria-label={onEditSide ? `Edit ${which}` : undefined}
      onClick={onEditSide ? () => onEditSide(which) : undefined}
      onKeyDown={
        onEditSide
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEditSide(which);
              }
            }
          : undefined
      }
      sx={{
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        ...(onEditSide && {
          cursor: "pointer",
          px: 0.5,
          mx: -0.5,
          transition: "background-color 120ms",
          "&:hover": { bgcolor: (t: Theme) => t.spec.hover },
          "&:focus-visible": {
            outline: "1px solid",
            outlineColor: (t: Theme) => t.spec.indicator,
            outlineOffset: 0,
          },
        }),
      }}
    >
      {codes.map((c) => (
        <AirportPill key={c} code={c} names={names} />
      ))}
    </Stack>
  );

  // The connector is bundled with the side it LEADS TO, in a nowrap group. On a
  // narrow screen the diagram then breaks between groups; left as loose siblings
  // it breaks after the connector instead, leaving a rule pointing at nothing and
  // the destination orphaned on the next line.
  return (
    <Stack
      direction="row"
      spacing={1.25}
      useFlexGap
      sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
    >
      {side(origins, "origins")}
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "nowrap" }}>
        <Connector roundTrip={route.round_trip === 1} />
        {side(destinations, "destinations")}
      </Stack>
    </Stack>
  );
}

/**
 * One field of the header's spec, as a bare value.
 *
 * There used to be an overline label above each of these, which is what made a
 * row of chips a legible record of choices — and what made the header two rows
 * tall. The label became the tooltip: the values are self-describing (a date
 * range, cabin chips, card marks) and the sentence explaining each is one hover
 * away, on the value itself rather than on a caption above it.
 */
function SpecValue({
  help,
  onClick,
  children,
}: {
  help: string;
  /** Makes the value a shortcut into the edit dialog, landing on the field it
   *  states. Every value here IS a form field, so the header doubles as the
   *  form's table of contents — you read a setting and touch it in one move,
   *  instead of opening a dialog of thirteen controls and finding it again. */
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip
      title={
        onClick ? (
          <>
            {help}
            <Box component="span" sx={{ display: "block", mt: 0.5, opacity: 0.75 }}>
              Click to edit.
            </Box>
          </>
        ) : (
          help
        )
      }
      placement="bottom-start"
    >
      <Box
        // A Box with a role, never a `<button>`: MUI `Chip` renders a `div`, and
        // a div inside a button is invalid HTML that browsers reflow around.
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        sx={{
          minWidth: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          alignItems: "center",
          cursor: onClick ? "pointer" : "help",
          // Negative margin against the padding, so the hover ground has room
          // around the value without widening the row when nothing is hovered —
          // this strip is sticky and must not move as the pointer crosses it.
          ...(onClick && {
            px: 0.5,
            mx: -0.5,
            py: 0.25,
            my: -0.25,
            transition: "background-color 120ms",
            "&:hover": { bgcolor: (t: Theme) => t.spec.hover },
            "&:focus-visible": {
              outline: "1px solid",
              outlineColor: (t: Theme) => t.spec.indicator,
              outlineOffset: 0,
            },
          }),
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

/**
 * The selected route's header: what this route is, and the controls that act
 * on it, on one line.
 *
 * ONE ROW, and it stays put. It was two tiers — identity above, a labelled
 * six-cell spec grid below — which cost about 120px of the pane before a single
 * find, and scrolled away the moment you read past the first page of results.
 * A sticky band only earns its height once, so it has to be short: the spec is
 * still all here, but as bare values with their labels moved into tooltips, and
 * the two cells that were neither identity nor filter are gone. Search cost
 * belongs to the button that spends it (and to the Edit dialog, which still
 * quotes it); "last searched" is per-find in the table below and per-route in
 * the rail. The find count is gone for the same reason — the rail already
 * counts every route, including this one.
 *
 * `position: sticky` resolves against the editor pane's own scroller from `md`
 * up and against the stacked page below it, so the same `top: 0` is right on
 * both.
 */
function RouteHeader({
  route,
  names,
  alert,
  intervalMinutes,
  onEdit,
  onBack,
  actions,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** This route's row from `GET /api/alerts/schedule`, when it has one and the
   *  query has landed. Only HEALTH and CADENCE come from here; the settings
   *  themselves are on `route`. Absent for a route with alerts off, and absent
   *  for every route until the shell's poll resolves — so nothing may depend on
   *  it being there. */
  alert?: AlertScheduleRoute;
  /** The pacing interval the scheduler is actually keeping, as the server
   *  computed it. Never re-derived here — see docs/ALERTS.md §4. */
  intervalMinutes?: number | null;
  /** Open the edit dialog, optionally landing on one field. */
  onEdit: (focus?: RouteField) => void;
  /** Back to the route list. Only reachable below `md`, where the rail and this
   *  pane are two screens rather than two panes — see the workbench grid. */
  onBack: () => void;
  actions: React.ReactNode;
}) {
  const cabins = parseCodeList(route.cabins);
  const currencies = parseCodeList(route.currencies);
  const days = dayCount(route.date_start, route.date_end);
  const alertsOn = route.alerts_enabled === 1;

  return (
    // Full-bleed, with one rule under it and nothing else: this is the top of
    // the editor pane, not a card floating in a page. Opaque `background.default`
    // is load-bearing now that it is sticky — the table scrolls underneath it.
    <Box
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 3,
        bgcolor: "background.default",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ px: { xs: 1.5, sm: 2.5 }, py: 1, alignItems: "center", flexWrap: "wrap" }}
      >
        {/* Back to the list, and only below `md` — above it the list is already
            on screen to the left, so this would be a button that undoes nothing.
            Hidden with `sx` rather than a second `useIsNarrow`: it is genuinely
            just visibility, and it sits inside a header that is already sticky,
            so it is reachable from anywhere in a long page of finds. */}
        <IconButton
          size="small"
          aria-label="All routes"
          onClick={onBack}
          sx={{ display: { xs: "inline-flex", md: "none" }, flexShrink: 0, ml: -0.5 }}
        >
          <ArrowBackRoundedIcon fontSize="small" />
        </IconButton>

        {/* A FIXED width, so the spec and the buttons sit at the same x on every
            route. The diagram's natural width tracks how many airports the route
            watches and which way it runs, so left to size itself it moved the
            whole rest of the header sideways every time you picked a different
            route in the rail — the one motion a header you are scanning down a
            list with must not have. Wide enough for two airports a side; a 3×3
            route wraps inside the box rather than pushing anything. */}
        <Box sx={{ width: { xs: "auto", sm: ROUTE_DIAGRAM_WIDTH }, flexShrink: 0 }}>
          <RouteDiagram route={route} names={names} onEditSide={onEdit} />
        </Box>

        {/* The spec, unlabelled. Every value keeps the help text its overline
            used to carry, so nothing about the route became unexplained — only
            unlabelled, which is what buys the row back. */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
        >
          <SpecValue
            help="The departure dates this route watches."
            onClick={() => onEdit("dateStart")}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {usDate(route.date_start)} – {usDate(route.date_end)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              {days}d
            </Typography>
          </SpecValue>

          {/* The one value here describing what the route GATHERS rather than
              what it shows — every other setting can be changed and seen
              instantly, this one needs a search behind it. The diagram draws it
              too (two planes), so it is a chip only when it is on. */}
          {route.round_trip === 1 && (
            <SpecValue
              help="Round trip searches the reverse pair in the same call, for no extra seats.aero calls. It changes what is gathered, so it needs a search."
              onClick={() => onEdit("roundTrip")}
            >
              <Chip size="small" color="primary" variant="outlined" label="Round trip" />
            </SpecValue>
          )}

          <SpecValue
            help="Cabins. Results outside these are stored, just not shown here."
            onClick={() => onEdit("cabins")}
          >
            {cabins.length > 0 ? (
              cabins.map((c) => <CabinChip key={c} cabin={c} />)
            ) : (
              <Chip size="small" variant="outlined" label="Any cabin" />
            )}
          </SpecValue>

          {currencies.length > 0 && (
            <SpecValue
              help="Cards: only space bookable with these — by transfer, or by buying the cash fare through that card's portal."
              onClick={() => onEdit("currencies")}
            >
              <BookableCurrencies json={route.currencies ?? undefined} size={20} />
            </SpecValue>
          )}

          {/* Constraints, and only when they constrain. An unset filter is the
              default reading of a row that doesn't mention it, and two "Any"
              chips in a sticky strip are two chips of nothing. */}
          {route.direct_only ? (
            <SpecValue
              help="Nonstop-only filters what this route SHOWS. Connecting itineraries are still gathered and still stored, so turning it off brings them straight back — no search, no API call."
              onClick={() => onEdit("directOnly")}
            >
              <Chip size="small" color="info" variant="outlined" label="Nonstop" />
            </SpecValue>
          ) : null}

          {(route.min_seats ?? 1) > 1 && (
            <SpecValue
              help="Finds with fewer seats than this are hidden here."
              onClick={() => onEdit("minSeats")}
            >
              <Chip size="small" variant="outlined" label={`${route.min_seats}+ seats`} />
            </SpecValue>
          )}

          {/* Alerts, and — alone on this row — stated even when OFF.
              Everything else here is a filter, whose absence reads correctly as
              "not filtered"; alerts are a whole feature, and a route that isn't
              enrolled looks exactly like an app that doesn't have them. This
              muted chip is the only place the Routes page says otherwise, and
              it is one click from turning them on. */}
          <SpecValue
            help={alertsOn ? alertHelp(route, alert, intervalMinutes) : ALERTS_OFF_HELP}
            onClick={() => onEdit(alertsOn ? "alertOn" : "alertsEnabled")}
          >
            {alertsOn ? (
              <Chip
                size="small"
                variant="outlined"
                color={alert ? ALERT_HEALTH[alertHealth(alert)].chipColor : "default"}
                icon={<NotificationsActiveRoundedIcon />}
                label={alertOnLabel(route)}
              />
            ) : (
              <Chip
                size="small"
                variant="outlined"
                icon={<NotificationsNoneRoundedIcon />}
                label="Alerts off"
                sx={{
                  color: "text.disabled",
                  borderColor: "divider",
                  "& .MuiChip-icon": { color: "text.disabled" },
                }}
              />
            )}
          </SpecValue>
        </Stack>

        {/* Eats the slack, so the actions sit at the right edge however wide the
            spec runs — and on a wrap they lead the second line rather than
            trailing whatever fell there. */}
        <Box sx={{ flex: "1 1 0", minWidth: 0 }} />

        {/* Four labelled buttons. On a phone they take a full-width line of
            their own rather than being dealt out one per line by the parent's
            wrap — `flexWrap` inside this Stack then packs them two-up, which is
            what fits. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            width: { xs: "100%", md: "auto" },
          }}
        >
          {actions}
        </Stack>
      </Stack>
    </Box>
  );
}

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
function EditRouteDialog({
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
  // object: the dashboard refetches for reasons of its own (a search finishing
  // under this route), and re-seeding on a new object identity would throw away
  // half-typed edits every time one landed.
  useEffect(() => {
    if (route) setForm(formFromRoute(route));
  }, [route?.id]);

  // The mutation variable is "…and then search it": one write path, so the two
  // buttons cannot drift on what they save, only on what happens after.
  const save = useMutation<unknown, Error, boolean>({
    mutationFn: () =>
      api.updateTrackedRoute(route!.id, {
        origins: form.origins,
        destinations: form.destinations,
        dateStart: form.dateStart,
        dateEnd: form.dateEnd,
        cabins: form.cabins,
        currencies: form.currencies,
        minSeats: form.minSeats,
        directOnly: form.directOnly,
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
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      onClose();
      // A plain save needs nothing further: the dialog is only ever opened on the
      // selected route, and the invalidations above already redraw its pane with
      // the new spec. The invalidations are what makes it honest — a narrowed
      // route hides stored finds the moment the dashboard refetches.
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
          <RouteFormFields form={form} setForm={setForm} focus={target?.focus} />
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

/** One side of a route in cities rather than codes: `Seattle/Portland`. Same
 *  slash form as `sideLabel`, so the two lines read as the same sentence twice. */
function citySideLabel(
  json: string | null,
  fallback: string,
  names: Map<string, AirportName>,
): string {
  return parseCodes(json, fallback)
    .map((c) => cityLabel(names.get(c), c))
    .join("/");
}

/**
 * Which way a route is drawn, everywhere it is drawn as text.
 *
 * `⇄` is not decoration: a round-trip route gathers and shows the reverse pair
 * too, so drawing it with a one-way arrow states the wrong thing about what the
 * route contains. Shared by the rail and the delete/enrich confirmations so they
 * cannot disagree.
 */
function directionArrow(r: TrackedRoute): string {
  return r.round_trip === 1 ? "⇄" : "→";
}

/** A route's shape in one line, for a rail row: `SEA/PDX → NRT/HND`, with the
 *  cities under it once the airport lookup has landed. The rail is narrow, so
 *  this is the CITY and never the airport's full name — "Seattle–Tacoma
 *  International Airport/Portland International Airport" is one ellipsis. The
 *  full name lives on the header's pills, where there is room for it. */
function RailRoute({
  route,
  names,
  mark,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** Sits immediately right of the CODES, on their own line. It used to be a
   *  sibling of this whole block, which put it past the widest of the two lines
   *  — and the city line under `SEA/PDX ⇄ NRT/HND` is much the wider, so the
   *  mark ended up floating in the middle of the row, attached to nothing. */
  mark?: React.ReactNode;
}) {
  const origins = parseCodes(route.origins, route.origin);
  const destinations = parseCodes(route.destinations, route.destination);
  // Suppressed wholesale until something resolved: every unresolved code falls
  // back to itself, so a half-empty map would print the code line twice.
  const known = [...origins, ...destinations].some((c) => names.has(c));

  return (
    <Box sx={{ minWidth: 0 }}>
      {/* A flex row rather than the mark inline INSIDE the Typography: that
          line is `noWrap`, so a wide route would ellipsise its own status
          icon away. Here the codes shrink and the mark does not. */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
        <Typography
          component="div"
          noWrap
          sx={{
            fontWeight: 700,
            letterSpacing: 0.3,
            lineHeight: 1.35,
            minWidth: 0,
          }}
        >
          {sideLabel(route.origins, route.origin)}
          <Box component="span" sx={{ color: "text.disabled", mx: 0.6, fontWeight: 400 }}>
            {directionArrow(route)}
          </Box>
          {sideLabel(route.destinations, route.destination)}
        </Typography>
        {mark}
      </Box>
      {known && (
        <Typography
          variant="caption"
          color="text.disabled"
          noWrap
          sx={{ display: "block", fontSize: 10.5, lineHeight: 1.4 }}
        >
          {citySideLabel(route.origins, route.origin, names)}
          <Box component="span" sx={{ mx: 0.5 }}>
            {directionArrow(route)}
          </Box>
          {citySideLabel(route.destinations, route.destination, names)}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The route rail: every monitored route, with the window and filters that define
 * it and the number of finds currently sitting inside them.
 *
 * This replaced a column of accordions. The finds table is tall — an itinerary
 * per row — so stacking routes vertically meant one route's results pushed the
 * next route's heading off the screen, and reading any of them started with
 * folding the others. Selection does that for free, and the rail keeps every
 * route's shape visible while you read one of them.
 *
 * The entries are flush rows divided by a hairline — cells of a one-column
 * table, not a stack of cards. They were cards, and at a handful of routes that
 * was four nested borders' worth of chrome to say "these are separate things",
 * which a single rule says quietly. Selection still gets a tint and the accent
 * bar, so it never depends on the divider it doesn't own.
 */
/**
 * The rail's alerts mark: one 14px bell, tinted by how the route's sweep is
 * going.
 *
 * Two states and no more: **yellow is armed, red is broken.** At 14px with no
 * label beside it a five-way tint is unreadable, so the detail is in the
 * tooltip and the silhouette only answers "should I be worried".
 *
 * Falls back to plain yellow whenever there is no schedule row — the shell's
 * poll not landed yet, the query refused, or a route enrolled seconds ago and
 * not yet in the server's answer. "Alerts are on" is known from the route itself
 * and must never blink; only the tint and the tooltip are conditional.
 */
function RailAlertBell({ alert }: { alert?: AlertScheduleRoute }) {
  const state = alert ? ALERT_HEALTH[alertHealth(alert)] : undefined;
  // An OUTLINE bell for a route that is armed but deliberately silent, so
  // "baseline pending" is legible without a chip. See docs/ALERTS.md §5.
  const Icon =
    alert && alertHealth(alert) === "baseline"
      ? NotificationsNoneRoundedIcon
      : NotificationsActiveRoundedIcon;
  return (
    <Tooltip title={state?.help ?? "Alerts on — re-searched automatically"}>
      <Icon
        fontSize="inherit"
        aria-label={state ? `Alerts: ${state.label}` : "Alerts on"}
        sx={{ flexShrink: 0, color: state?.iconColor ?? "warning.main", fontSize: 14 }}
      />
    </Tooltip>
  );
}

function RouteNav({
  routes,
  counts,
  names,
  alerts,
  selectedId,
  onSelect,
  onAdd,
}: {
  routes: TrackedRoute[];
  counts: Map<number, number>;
  /** The same lookup the header's pills read, so the rail and the detail pane
   *  can't name one airport two ways. */
  names: Map<string, AirportName>;
  /** Alert HEALTH by route id, from `GET /api/alerts/schedule`. Empty until the
   *  shell's poll lands, and it never holds a route whose alerts are off — so
   *  a missing entry is normal, not an error. */
  alerts: Map<number, AlertScheduleRoute>;
  selectedId?: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}) {
  return (
    // The sidebar. Not a `Paper` any more, and that is the whole change: a card
    // has an edge on all four sides and a gap around it, while a sidebar has ONE
    // edge — the rule it shares with the editor — and runs the full height of
    // the window. It reads as a separate pane because it is painted in
    // `background.chrome`, the same ground as the tab strip and every table
    // head, which is exactly the relationship VS Code's sidebar has to its
    // editor.
    <Box
      sx={{
        bgcolor: "background.chrome",
        // `ruleSoft`, not `divider`: the change of ground between this pane and
        // the editor is already the separation, so the line only has to confirm
        // it. A full-weight rule here read as a seam holding two halves apart
        // rather than as one surface meeting another.
        borderRight: { md: "1px solid" },
        borderBottom: { xs: "1px solid", md: "none" },
        borderColor: "ruleSoft",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        // Lets the grid's `fit-content()` cap actually clamp this column: the
        // rail's `noWrap` route lines would otherwise set a min-content floor
        // that no maximum can lower.
        minWidth: 0,
      }}
    >
      {/* The sidebar's section header, in VS Code's own idiom: small, spaced,
          uppercase, on the chrome ground, with its one action at the right.
          `useFlexGap`, so the New button's `ml: auto` actually reaches that
          edge — Stack's default `spacing` is a margin-left on every child but
          the first, and that margin outranks `auto`. */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{
          px: 1.5,
          py: 0.75,
          minHeight: 34,
          alignItems: "center",
          flexShrink: 0,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
          Routes
        </Typography>
        <Chip
          size="small"
          label={routes.length}
          // `accentMuted` + `secondary` (the accent as INK): `primary.main` is
          // now the accent as a GROUND and far too dark to set type in.
          sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }}
        />
        {/* Outlined success, the same green as a route's find count below it:
            adding a route is the one thing this header does, and the colour it
            already means in this column is "there is something here". */}
        <Tooltip title="Track a new route">
          <Button
            size="small"
            variant="outlined"
            color="success"
            onClick={onAdd}
            startIcon={<AddRoundedIcon fontSize="small" />}
            sx={{ ml: "auto", minHeight: 22, py: 0, px: 0.75 }}
          >
            New
          </Button>
        </Tooltip>
      </Stack>
      {/* The list scrolls, the header does not — a sidebar's title stays put
          while its contents move, and this is the pane's own scrollbar rather
          than the window's. */}
      {/* Its own scrollbar at EVERY width now, not just from `md` up: below that
          this pane is the whole screen rather than a stacked block, so the list
          scrolling itself is what a list screen does. */}
      <List disablePadding sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {routes.map((r) => {
          const found = counts.get(r.id) ?? 0;
          return (
            <ListItemButton
              key={r.id}
              // `li`, because the default `div` inside `List`'s `ul` is
              // invalid HTML.
              component="li"
              selected={r.id === selectedId}
              onClick={() => onSelect(r.id)}
              sx={{
                display: "block",
                position: "relative",
                px: 2,
                py: 1.25,
                // One rule between rows and none under the last, so the rail
                // ends on its own edge rather than a stray line.
                borderBottom: "1px solid",
                borderColor: "divider",
                "&:last-of-type": { borderBottom: "none" },
                transition: "background-color 120ms",
                // The accent bar is a pseudo-element rather than a border, so
                // selecting a row doesn't reflow its text by 3px.
                "&::before": {
                  content: '""',
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  bgcolor: (t) => t.spec.indicator,
                  opacity: 0,
                  transition: "opacity 120ms",
                },
                // The palette's own selection ground, not a wash of the accent —
                // but the QUIET one, paired with the bright bar above. A row
                // here carries a cabin chip, up to three airline marks and a
                // green find count, and `spec.selected` (a saturated fill meant
                // for rows of plain text) turns every one of them to mush. Bar
                // plus quiet ground is unambiguous and costs no information.
                "&.Mui-selected, &.Mui-selected:hover": {
                  bgcolor: (t) => t.spec.selectedIdle,
                },
                "&.Mui-selected::before": { opacity: 1 },
              }}
            >
              {/* `useFlexGap`, so the count chip's `ml: auto` actually reaches
                  the right edge: Stack's default `spacing` is a margin on every
                  child but the first, and it outranks `auto`. */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center" }}>
                {/* A route IS its shape: the pair, the window, the filters. That
                    is the one thing the rail is for — telling two SEA→NRT routes
                    apart at a glance — and a free-text label sat above it saying
                    nothing about geography. */}
                {/* A route that re-searches itself and emails you is spending
                    the metered allowance without anyone pressing anything, so
                    the rail says which ones do — and, when the schedule has
                    landed, whether they are working. A failing sweep sends no
                    email about itself (docs/ALERTS.md §1), so this bell is one
                    of the few places you would ever notice.

                    It rides on the CODES line rather than beside this whole
                    block, so it reads as a mark on the route's name. One icon
                    and a tooltip is the whole budget: the row already carries
                    two lines of label, a cabin chip, card marks and a count. */}
                <Box sx={{ minWidth: 0 }}>
                  <RailRoute
                    route={r}
                    names={names}
                    mark={r.alerts_enabled === 1 ? <RailAlertBell alert={alerts.get(r.id)} /> : null}
                  />
                </Box>
                <Box sx={{ ml: "auto", flexShrink: 0 }}>
                  {found > 0 ? (
                    <Chip size="small" variant="outlined" color="success" label={found} />
                  ) : (
                    // "Nobody has looked" and "looked, nothing there" are
                    // different answers, and the rail is where you notice.
                    !r.last_checked_at && (
                      <Chip size="small" variant="outlined" color="warning" label="unsearched" />
                    )
                  )}
                </Box>
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.25 }}
              >
                {usDate(r.date_start)} – {usDate(r.date_end)}
                <Box component="span" sx={{ color: "text.disabled" }}>
                  {" · "}
                  {dayCount(r.date_start, r.date_end)}d
                </Box>
              </Typography>
              <Box sx={{ mt: 0.75 }}>
                <RouteFilters route={r} />
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

export function Routes() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });

  // How each alert route's sweep is actually going, for the rail's bell and the
  // header's chip.
  //
  // The SAME key and fetcher the shell's `AlertsHealthDot` already polls every
  // five minutes (router.tsx), so this is a read of a warm cache and costs no
  // request — and deliberately carries NO `refetchInterval` of its own, because
  // a second interval on one key would fight the shell's for who refetches
  // when. `retry: false` for the same reason it has it there: alert health is
  // not itself an alarm, and a page that failed to load because of it would be.
  const alertSchedule = useQuery({
    queryKey: ["alert-schedule"],
    queryFn: api.alertSchedule,
    retry: false,
  });
  const alertById = useMemo(
    () => new Map((alertSchedule.data?.routes ?? []).map((r) => [r.id, r])),
    [alertSchedule.data],
  );

  const [addOpen, setAddOpen] = useState(false);
  // The route the edit dialog is open on and which field it should land on,
  // `null` when it is closed — the same payload shape `confirmEnrich` uses
  // below, and what lets one mounted dialog serve every route.
  const [editRoute, setEditRoute] = useState<EditTarget | null>(null);
  const [confirmDel, setConfirmDel] = useState<TrackedRoute | null>(null);
  // The route about to be enriched, with the call count the dialog quotes.
  const [confirmEnrich, setConfirmEnrich] = useState<{
    route: TrackedRoute;
    calls: number;
  } | null>(null);
  // Held here rather than per-route so only one payload is ever mounted.
  const [openCall, setOpenCall] = useState<SearchCall | null>(null);
  // Streams, not request/responses — their partial state is the point, so they
  // live outside TanStack Query. See useRouteSearch / useRouteEnrich.
  //
  // Held HERE, at the page, rather than inside the detail pane: their state is
  // keyed by route id, so a search under a route you have navigated away from
  // keeps running and is still filling in when you come back.
  const search = useRouteSearch();
  const enrich = useRouteEnrich();

  // Display preferences for THIS browser, from localStorage — not the URL (a
  // preference should appear in no link) and not D1 (one shared identity means
  // one server-side setting for both users). Set from the header's gear.
  const prefs = usePreferences();

  // Below `md` the rail and the editor are two SCREENS rather than two panes;
  // see the workbench grid and `selected` below.
  const narrow = useIsNarrow();

  // Which route the detail pane is showing, from the URL — so a reload, a
  // bookmark and the back button all land where you left off.
  const navigate = useNavigate({ from: "/" });
  const {
    route: routeParam,
    minNights: minParam,
    maxNights: maxParam,
  } = useSearch({ from: "/" });
  // Absent means the route's own window — the default reading, which filters
  // nothing. Only a range somebody actually chose lives in the URL, and half a
  // range is not a range (`validateSearch` drops the pair together).
  const nights: [number, number] | null =
    minParam != null && maxParam != null ? [minParam, maxParam] : null;

  // Every navigate on this page MERGES rather than replaces. `search: { route }`
  // would drop `view` and the nights range on the floor, so clicking a rail entry
  // would silently close the round-trip view you were reading.
  const setSearch = (patch: Partial<RoutesSearchParams>, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });

  // Shared key with QuotaIndicator and the finds table's per-row control, so the
  // confirm dialog can quote today's allowance without a fetch of its own.
  const quotaQ = useQuery({ queryKey: ["quota"], queryFn: api.quota });
  const quotaLeft = quotaQ.data?.quota.find(
    (q) => q.source === "api:seatsaero" && q.day === quotaQ.data?.today,
  )?.remaining;

  // Airport names for every code on screen, in one round trip.
  //
  // Every airport the page can name, not just the two scalars: the header draws
  // each origin and destination as its own pill and every one of them wants a
  // name behind it. The trip lists below resolve their own codes through the
  // same hook and the same cache — a find can route through an airport no
  // tracked route mentions.
  const names = useAirportNames(
    (data?.trackedRoutes ?? []).flatMap((r) => [
      ...parseCodes(r.origins, r.origin),
      ...parseCodes(r.destinations, r.destination),
    ]),
  );

  /**
   * What both route dialogs end in: select the route, then search it.
   *
   * A route is a *question*, and until something has looked at it the dashboard
   * cannot tell "nothing is available" from "nobody has asked" — the one
   * confusion this app is built to avoid. Editing has the same problem in
   * miniature: a window moved forward two months is mostly dates nobody has
   * checked — but only *some* edits do that, so the edit dialog offers a plain
   * Save beside this one and `EditRouteDialog` calls this for the "& search" half
   * alone. Every button that reaches here says "& search" and both dialogs quote
   * the call range above them, so the spend is stated before it happens.
   *
   * Safe to call for a route the pane hasn't rendered yet: the run state is keyed
   * by id on the page, and the endpoint is addressed by id too.
   */
  const searchAfterSave = (id: number) => {
    setSearch({ route: id });
    search.start(id);
  };

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTrackedRoute(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      setConfirmDel(null);
    },
  });

  if (isLoading)
    return (
      <Stack sx={{ py: 8, alignItems: "center" }}>
        <CircularProgress />
      </Stack>
    );
  if (error) return <Alert severity="error">Failed to load: {String(error)}</Alert>;
  if (!data) return null;

  // Group current finds under the route that monitors them (tagged server-side).
  const findsByRoute = new Map<number, Find[]>();
  for (const f of data.bestFinds) {
    if (f.tracked_route_id == null) continue;
    const arr = findsByRoute.get(f.tracked_route_id) ?? [];
    arr.push(f);
    findsByRoute.set(f.tracked_route_id, arr);
  }
  const counts = new Map([...findsByRoute].map(([id, fs]) => [id, fs.length]));

  // Fall back to the first route rather than an empty pane: `?route=` can name a
  // route that has since been deleted, or a number someone typed.
  //
  // A NARROW screen does not fall back, and that is what turns the workbench
  // into a list and a detail view without inventing any state to do it with.
  // With one pane on screen at a time, "no route chosen" is a real and useful
  // answer — it means the list — and picking one is what opens the editor. The
  // selection was already in the URL (`?route=`), so back, reload and bookmark
  // all keep working exactly as they did.
  const selected =
    data.trackedRoutes.find((r) => r.id === routeParam) ??
    (narrow ? undefined : data.trackedRoutes[0]);

  return (
    // The workbench: a sidebar and an editor, sharing one 1px rule and nothing
    // else. No page padding, no gap between the panes, no rounded cards — what
    // separates them is a change of GROUND (the rail is `background.chrome`, the
    // editor is `background.default`, exactly VS Code's sidebar/editor pair) plus
    // that single rule. Gaps and shadows are how a dashboard says "these are
    // different"; an editor says it with colour and a line, and gets the pixels
    // back.
    <Box sx={{ height: "100%", minHeight: 0 }}>
      {/* The seats.aero allowance this page spends is in the app bar, not here:
          the enrich control on every finds row spends it too, and a number you
          have to scroll to is one you check after the fact. See QuotaIndicator. */}
      {data.trackedRoutes.length === 0 ? (
        // With no routes there is no workbench to draw — a sidebar listing
        // nothing beside an editor showing nothing is two empty panes. So this
        // one state falls back to being a document.
        <PagePad>
          <SectionHeading
            title="Routes"
            action={
              <Button
                variant="contained"
                size="small"
                startIcon={<AddRoundedIcon />}
                onClick={() => setAddOpen(true)}
              >
                New route
              </Button>
            }
          />
          <Typography color="text.secondary" variant="body2">
            No routes yet. Add one, then press Search to look for award space.
          </Typography>
        </PagePad>
      ) : (
        // `minmax(0, 1fr)` on the editor column, not `1fr`: a grid track sizes
        // to its content by default, so a wide finds table would push the rail
        // off the left edge instead of scrolling inside its own pane.
        //
        // The rail is `fit-content(RAIL_MAX)`: as narrow as the routes it holds,
        // and never wider than the cap. It was a flat 320px, which is a guess
        // about the longest route somebody might track — a rail of `PIT ⇄ SEA`
        // rows paid for `SEA/PDX/BFI ⇄ NRT/HND/KIX` whether or not one existed.
        // The cap still matters: `RailRoute`'s two lines are `noWrap`, so an
        // uncapped track would size to the longest untruncated city pair. The
        // `minWidth: 0` inside `RouteNav` is what lets the clamp bite — without
        // it those `noWrap` lines set a min-content floor the cap can't lower.
        //
        // Two scroll containers from `md` up, one below it. On a desktop each
        // pane scrolls independently, which is the entire point of a full-height
        // sidebar; on a phone the columns stack, so a pane with its own scrollbar
        // would be a short box inside a page you also have to scroll.
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: `fit-content(${RAIL_MAX_WIDTH}px) minmax(0, 1fr)`,
            },
            height: "100%",
            minHeight: 0,
            // Never the page's own scroller, at any width. Below `md` only ONE
            // of the two panes renders, and that pane scrolls itself — which is
            // also what keeps `RouteHeader` sticky against something on a phone
            // instead of against a page the rail has already been scrolled off.
            overflowY: "hidden",
          }}
        >
          {/* One pane at a time below `md`: the rail is the list screen, the
              editor is the detail screen, and `?route=` is which one you are on.
              Both render side by side from `md` up, unchanged. */}
          {(!narrow || !selected) && (
            <RouteNav
              routes={data.trackedRoutes}
              counts={counts}
              names={names}
              alerts={alertById}
              selectedId={selected?.id}
              onSelect={(id) => setSearch({ route: id })}
              onAdd={() => setAddOpen(true)}
            />
          )}
          {data.trackedRoutes
            .filter((r) => r.id === selected?.id)
            .map((r) => {
              const routeFinds = findsByRoute.get(r.id) ?? [];
              const run = search.runs[r.id];
              const running = search.isRunning(r.id);
              const enrichRun = enrich.runs[r.id];
              const enriching = enrich.isRunning(r.id);
              // Summary finds that still carry an enrichment handle. Counted off
              // the rows on screen rather than asked of the server: the button
              // has to state a call cost before it is pressed, and this is the
              // same set the endpoint will target. One call covers a whole
              // (date, program), so the CALL count is the distinct availability
              // ids, not the row count — four cabins of one flight are one call.
              const enrichable = new Set(
                routeFinds
                  .filter((f) => f.detail_level === "summary" && f.source_record_id)
                  .map((f) => f.source_record_id as string),
              );
              return (
                // The editor pane. Its own scroller from `md` up so the header
                // and the finds table scroll past a rail that stays put.
                <Box
                  key={r.id}
                  sx={{
                    minWidth: 0,
                    minHeight: 0,
                    overflowY: "auto",
                  }}
                >
                  <RouteHeader
                    route={r}
                    names={names}
                    alert={alertById.get(r.id)}
                    intervalMinutes={alertSchedule.data?.pacing.intervalMinutes}
                    onEdit={(focus) => setEditRoute({ route: r, focus })}
                    // `setSearch` merges rather than replaces, so going back to
                    // the list keeps any nights range the route was being read
                    // with — come forward again and you are where you were.
                    onBack={() => setSearch({ route: undefined })}
                    actions={
                      <>
                        {/* Text, not an icon: this runs for tens of seconds and
                            needs to say so. Goes to the Worker, which calls
                            seats.aero — the one source that does not need a
                            residential IP — and writes what it finds into the
                            same database local gathering does. "Re-search" once the
                            route has a `last_checked_at`, so the button says
                            whether this window has ever been looked at — which is
                            now the only place the header says it, and it says it
                            on the control you are about to press. */}
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => search.start(r.id)}
                          disabled={running}
                          startIcon={
                            running ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <SearchRoundedIcon fontSize="small" />
                            )
                          }
                        >
                          {running ? "Searching…" : r.last_checked_at ? "Re-search" : "Search"}
                        </Button>
                        {/* Only offered when there is something to buy. Spends
                            one metered call per availability row, so unlike
                            Search it confirms first and says how many — a wide
                            date window could otherwise cost 25 calls on one
                            click. */}
                        {(enrichable.size > 0 || enriching) && (
                          <Tooltip
                            title={
                              enriching
                                ? "Fetching real flight numbers and times"
                                : `${enrichable.size} find${
                                    enrichable.size === 1 ? "" : "s"
                                  } here are summaries — fetch their real itineraries`
                            }
                          >
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={enriching || running}
                                onClick={() =>
                                  setConfirmEnrich({ route: r, calls: enrichable.size })
                                }
                                startIcon={
                                  enriching ? (
                                    <CircularProgress size={16} color="inherit" />
                                  ) : (
                                    <AltRouteRoundedIcon fontSize="small" />
                                  )
                                }
                              >
                                {enriching
                                  ? `Enriching ${enrichRun?.done ?? 0}/${enrichRun?.targets ?? 0}…`
                                  : "Enrich all"}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                        {/* Edit and Remove carry the same weight as Search:
                            same size, same fill, same labelled shape, and only
                            the colour saying what each is for. They were two
                            small icons beside a filled button, which reads as
                            one control and some decoration — but correcting a
                            window you got wrong is as much a part of running a
                            route as searching it, and both of these are one
                            undo-less click from a dialog you have to mean.
                            Neutral and error tints rather than solid fills, so
                            "equal" doesn't mean three shouting buttons.

                            Everything the spec beside these buttons states is
                            editable from Edit — the row is that form, read-only,
                            and Edit is where the call cost is quoted. */}
                        <Button
                          size="small"
                          variant="contained"
                          color="inherit"
                          onClick={() => setEditRoute({ route: r })}
                          startIcon={<EditRoundedIcon fontSize="small" />}
                          sx={{
                            color: "text.primary",
                            bgcolor: "background.raised",
                            "&:hover": { bgcolor: (t) => t.spec.selectedIdle },
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          color="error"
                          onClick={() => setConfirmDel(r)}
                          disabled={del.isPending && del.variables === r.id}
                          startIcon={<DeleteOutlineRoundedIcon fontSize="small" />}
                          sx={{
                            color: "error.light",
                            bgcolor: (t) => alpha(t.palette.error.main, 0.18),
                            boxShadow: "none",
                            "&:hover": {
                              bgcolor: (t) => alpha(t.palette.error.main, 0.3),
                              boxShadow: "none",
                            },
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    }
                  />

                  {run && (
                    <SearchProgress
                      run={run}
                      onOpenCall={setOpenCall}
                      onDismiss={running ? undefined : () => search.dismiss(r.id)}
                    />
                  )}
                  {enrichRun && (
                    <EnrichProgress
                      run={enrichRun}
                      onDismiss={enriching ? undefined : () => enrich.dismiss(r.id)}
                    />
                  )}

                  {/* No view toggle: round trip is a PROPERTY of the route, like
                      its cabins or its window. It is stated in the header
                      above and changed in the Edit dialog, and the pane simply
                      shows what the route is. A toggle here would let the reading
                      disagree with the setting, which is the one thing a route's
                      own pane should never do. */}
                  {r.round_trip === 1 ? (
                    <RoundTripTable
                      route={r}
                      finds={routeFinds}
                      nights={nights}
                      onSearch={(id) => search.start(id)}
                      searching={running}
                      showMap={prefs.showMapColumn}
                      onNightsChange={(n) =>
                        // `undefined` for the whole-window default, which the
                        // router drops from the URL — so the default reading has
                        // no params, and a shared link only carries a trip
                        // length when somebody chose one.
                        setSearch({ minNights: n?.[0], maxNights: n?.[1] }, true)
                      }
                    />
                  ) : (
                    <>
                      {routeFinds.length > 0 ? (
                        // No wrapper. The table IS the editor's content, so it
                        // runs to both edges under the header's rule — a card
                        // around it would put a second border a pixel inside the
                        // pane and a margin outside that.
                        //
                        // Paged in the browser: the dashboard payload carries
                        // every find for every route, and a wide window can hold
                        // hundreds — enough that mounting them all made opening
                        // the route visibly slow.
                        <FindsTable
                          finds={routeFinds}
                          paginate
                          showMap={prefs.showMapColumn}
                        />
                      ) : null}
                      {routeFinds.length === 0 ? (
                        // "Nobody has looked" and "looked, found nothing" are the two
                        // answers this app exists to keep apart, so the empty state
                        // has to say which one it is.
                        <Typography
                          color="text.secondary"
                          variant="body2"
                          sx={{ px: 2.5, py: 2 }}
                        >
                          {r.last_checked_at
                            ? "No award space stored for this window right now."
                            : "This route has never been searched. Press Search to look for award space."}
                        </Typography>
                      ) : null}
                    </>
                  )}
                </Box>
              );
            })}
        </Box>
      )}

      <AddRouteDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
        }}
        onCreated={searchAfterSave}
      />
      <EditRouteDialog
        target={editRoute}
        onClose={() => setEditRoute(null)}
        onSaved={searchAfterSave}
      />

      <Dialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove route?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Remove the saved search{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {confirmDel?.origin}&nbsp;{confirmDel && directionArrow(confirmDel)}&nbsp;{confirmDel?.destination}
            </Box>{" "}
            ({confirmDel?.date_start} … {confirmDel?.date_end})? Its stored finds stay in the
            database.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmDel(null)} color="inherit">
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            startIcon={<DeleteOutlineRoundedIcon />}
            disabled={del.isPending}
            onClick={() => confirmDel && del.mutate(confirmDel.id)}
          >
            {del.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Search fires on click; this asks first, because it spends a metered
          call PER ROW and the number is not obvious from the button. Stating the
          cost against the remaining allowance is the whole content — there is no
          budget guard anywhere in this app, so an informed press is the only
          thing standing between a wide route and a quarter of the day. */}
      <Dialog
        open={!!confirmEnrich}
        onClose={() => setConfirmEnrich(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Fetch itineraries?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirmEnrich?.route.origin}&nbsp;{confirmEnrich && directionArrow(confirmEnrich.route)}&nbsp;{confirmEnrich?.route.destination} has{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {confirmEnrich?.calls} summary find{confirmEnrich?.calls === 1 ? "" : "s"}
            </Box>{" "}
            with no flight numbers. Fetching them costs{" "}
            <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
              {Math.min(confirmEnrich?.calls ?? 0, ENRICH_MAX_PER_RUN)} seats.aero call
              {Math.min(confirmEnrich?.calls ?? 0, ENRICH_MAX_PER_RUN) === 1 ? "" : "s"}
            </Box>
            {quotaLeft != null && ` of the ${quotaLeft.toLocaleString()} left today`}.
            {(confirmEnrich?.calls ?? 0) > ENRICH_MAX_PER_RUN &&
              ` Capped at ${ENRICH_MAX_PER_RUN} per run — the nearest dates go first, and you can run it again for the rest.`}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmEnrich(null)} color="inherit">
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<AltRouteRoundedIcon />}
            onClick={() => {
              if (!confirmEnrich) return;
              enrich.start(confirmEnrich.route.id);
              setConfirmEnrich(null);
            }}
          >
            Fetch
          </Button>
        </DialogActions>
      </Dialog>

      <CallDialog call={openCall} onClose={() => setOpenCall(null)} />

      {/* No global snackbar: a search failure belongs ON the route it failed
          for, not floating at the bottom of the page detached from it. See
          SearchProgress. */}
    </Box>
  );
}
