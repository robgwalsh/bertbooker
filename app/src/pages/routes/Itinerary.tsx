import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Button, CircularProgress, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import { api, type Find, type Segment } from "../../api";
import { PRIMARY_METERED_SOURCE } from "../../lib/quota";
import { AirlineLogo } from "../../components/brand";
import { bookingTarget } from "../../lib/booking";
import { flightAwareUrl, flightLabel, parseSegments } from "../../lib/flights";
import {
  clockTime12,
  dayLabel,
  dayOffset,
  formatDuration,
  layoverMinutes,
  sinceLabel,
} from "../../lib/format";

// The itinerary drawn in place, as the finds table's widest cell.
//
// Drawn rather than hidden behind an expander: the shape of a trip — how long,
// how many stops, how brutal the connection — is visible without opening
// anything, so the whole set is comparable at a glance. The columns to the
// right of it are unchanged.
//
// The two controls that act on the *itinerary* — fetch it, or go and book it —
// live here too rather than in a column at the far right of the table. Enriching
// is the fix for a card that says it has nothing to draw, and that is only
// legible next to the card saying so.
//
// Apart from the quota the enrich tooltip quotes, everything here is derived
// from `segments_json` plus the row's own `duration_minutes`/`stops` — so this
// stays cheap enough to mount a hundred of.

/** Height of the stop bar: the rail and dots on top, the codes underneath. */
const BAR_HEIGHT = 34;
const DOT = 7;

/** The card stops growing here. Past ~500px the stop bar stretches the gap
 *  between two airport codes across half the screen to say the same thing, and
 *  the departure and arrival times drift so far apart they stop reading as one
 *  itinerary. The table's remaining columns get the width instead. */
const CARD_MAX_WIDTH = 500;

/**
 * A connecting itinerary whose layovers are unmeasured.
 *
 * True when there is a second leg and it has no departure time — the exact shape
 * a search-embedded trip produces, since that payload carries the whole journey's
 * endpoints and nothing per leg. Mirrors the SQL predicate the bulk sweep uses in
 * `api/src/enrich.ts`; keep the two in step. A nonstop is fully timed by
 * definition and is never "timeless".
 */
function lacksLegTimes(f: Find): boolean {
  const legs = parseSegments(f.segments_json);
  return legs.length > 1 && !legs[1]!.departsAt;
}

/**
 * Whether this find describes a real aeroplane, and the one-click way to buy
 * that if it doesn't.
 *
 * seats.aero's Cached Search returns a per-cabin summary — space at a price,
 * with no itinerary — so those rows carry one synthetic segment and no flight
 * numbers. `GET /trips/{id}` has the real legs at **one API call per
 * availability row**, which is unaffordable across a search and trivial for the
 * one row someone is looking at. Hence a button rather than a gathering step.
 *
 * The tooltip always states the cost, because clicking spends a metered call
 * with no confirmation. The quota it quotes rides the shared `quota`
 * query key, so a hundred rows are one fetch.
 *
 * One click enriches every cabin of its (route, date, program): they share one
 * availability id, so the sibling rows update too and the whole group flips.
 *
 * Two shapes. On a drawn itinerary it is an **icon**, because there is nothing
 * to do and it is only reporting that the legs are real. On a summary stub it is
 * a **labelled button**, because there the missing itinerary is the whole
 * content of the cell and "you can fetch it" is the point — an unlabelled icon
 * three columns away was easy to never notice.
 */
function EnrichControl({ f, labelled }: { f: Find; labelled?: boolean }) {
  const qc = useQueryClient();
  const quotaQ = useQuery({ queryKey: ["quota"], queryFn: api.quota });

  const enrich = useMutation({
    mutationFn: () =>
      api.enrichFind({
        origin: f.origin,
        destination: f.destination,
        flightDate: f.flight_date,
        program: f.program,
      }),
    onSuccess: () => {
      // The finds table reads through `findsFrom`, as `/api/routes` does, so
      // both keys have to move — and the quota, since a call was spent.
      void qc.invalidateQueries({ queryKey: ["routes"] });
      void qc.invalidateQueries({ queryKey: ["finds"] });
      void qc.invalidateQueries({ queryKey: ["quota"] });
    },
  });

  // Absent reads as an itinerary: every source but seats.aero Cached Search
  // produces real legs at ingest.
  const isSummary = f.detail_level === "summary";
  // A connecting itinerary that knows its aeroplanes but not its clock. This is
  // what a search with `include_trips` produces: the embedded trip carries only
  // the whole journey's endpoints, so the layover between legs is genuinely
  // unmeasured. `/trips/{id}` is still the only place per-leg times live.
  const timeless = !isSummary && lacksLegTimes(f);
  const enrichable = (isSummary || timeless) && Boolean(f.source_record_id);
  // Tried, and seats.aero had no itinerary at this price. Distinct from "not
  // tried" precisely so the UI stops inviting the same wasted call.
  const triedAndEmpty = isSummary && Boolean(f.enriched_at);

  const today = quotaQ.data?.quota.find(
    (q) => q.source === PRIMARY_METERED_SOURCE && q.day === quotaQ.data?.today,
  );
  const left = today ? `${today.remaining.toLocaleString()} left today` : "quota unknown";

  const title = enrich.isError
    ? `Fetch failed: ${enrich.error instanceof Error ? enrich.error.message : "unknown error"} — click to retry`
    : timeless
      ? !f.source_record_id
        ? "Routing known; layover times unknown. Re-search the route to make it fetchable."
        : `Routing known, layover times not — click to fetch per-leg times (1 seats.aero call, ${left})`
      : !isSummary
        ? `Full itinerary${f.enriched_at ? ` · fetched ${sinceLabel(f.enriched_at)}` : ""}`
        : !f.source_record_id
          ? "Summary only — this row predates itinerary fetching. Re-search the route to make it enrichable."
          : triedAndEmpty
            ? `seats.aero had no itinerary at this price when asked ${sinceLabel(f.enriched_at)} — click to try again (1 call, ${left})`
            : `Summary only — click to fetch the real flights (1 seats.aero call, ${left})`;

  const color = enrich.isError ? "error" : triedAndEmpty ? "warning" : "primary";

  if (labelled) {
    // The label names the OUTCOME of the click, not the state it is in — except
    // for the two states where clicking is pointless or already answered, which
    // say so instead of inviting the call again.
    const label = enrich.isPending
      ? "Fetching…"
      : !f.source_record_id
        ? "Not enrichable"
        : enrich.isError
          ? "Retry fetch"
          : triedAndEmpty
            ? "None found — retry"
            : timeless
              ? "Fetch times"
              : "Fetch itinerary";
    return (
      <Tooltip title={title}>
        <span>
          <Button
            size="small"
            variant="text"
            color={color}
            disabled={!enrichable || enrich.isPending}
            onClick={() => enrich.mutate()}
            startIcon={
              enrich.isPending ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <AltRouteRoundedIcon fontSize="small" />
              )
            }
            sx={{ whiteSpace: "nowrap", minWidth: 0 }}
          >
            {label}
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (enrich.isPending)
    return (
      <IconButton size="small" disabled aria-label="Fetching itinerary">
        <CircularProgress size={16} />
      </IconButton>
    );

  return (
    <Tooltip title={title}>
      {/* A disabled IconButton fires no events, so the tooltip would vanish with
          it — the span keeps the explanation reachable. */}
      <span>
        <IconButton
          size="small"
          color={color}
          disabled={!enrichable}
          onClick={() => enrich.mutate()}
          aria-label={
            timeless
              ? "Fetch per-leg times"
              : isSummary
                ? "Fetch itinerary"
                : "Itinerary already fetched"
          }
        >
          <AltRouteRoundedIcon
            fontSize="small"
            sx={{ opacity: enrichable ? 0.55 : isSummary ? 0.25 : 1 }}
          />
        </IconButton>
      </span>
    </Tooltip>
  );
}

/**
 * What this slot has cost over time.
/** Out to the airline's own award page when a source handed us one, else a
 *  Google Flights search for the route and date. */
function BookLink({ f }: { f: Find }) {
  const book = bookingTarget(f);
  return (
    <Tooltip title={book.label}>
      <IconButton
        size="small"
        color={book.isAirline ? "primary" : "default"}
        component="a"
        href={book.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <OpenInNewRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

/** One node on the stop bar — an airport, with the layover spent there. */
export interface Stop {
  code: string;
  /** Minutes on the ground here. Only ever set on intermediate stops. */
  layover?: number | null;
}

/**
 * The route as a line with a dot per airport.
 *
 * Nodes are spaced EVENLY, not in proportion to flight time: a 1h positioning
 * hop before a 13h transpacific would otherwise pin the connection against the
 * left edge and squash its label, and the bar is a topology diagram — how many
 * stops, where, how long on the ground — not a timeline.
 *
 * Absolute positioning rather than flexbox because the labels have to stay
 * centred on their dots at any stop count; the two ends are pulled inward
 * (`translateX(0)` / `translateX(-100%)`) so a 3-letter code can't overhang the
 * cell.
 */
export function StopBar({ stops }: { stops: Stop[] }) {
  if (stops.length < 2)
    return (
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {stops.map((s) => s.code).join(" → ") || "—"}
      </Typography>
    );

  const last = stops.length - 1;
  return (
    <Box sx={{ position: "relative", height: BAR_HEIGHT, mt: 0.5 }}>
      <Box
        sx={{
          position: "absolute",
          left: DOT / 2,
          right: DOT / 2,
          top: (DOT - 2) / 2,
          height: 2,
          bgcolor: "divider",
        }}
      />
      {stops.map((s, i) => {
        const pct = (i / last) * 100;
        const shift = i === 0 ? "none" : i === last ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <Box
            key={`${s.code}-${i}`}
            sx={{
              position: "absolute",
              left: `${pct}%`,
              top: 0,
              transform: shift,
              display: "flex",
              flexDirection: "column",
              alignItems: i === 0 ? "flex-start" : i === last ? "flex-end" : "center",
              whiteSpace: "nowrap",
            }}
          >
            <Box
              sx={{
                width: DOT,
                height: DOT,
                borderRadius: "50%",
                bgcolor: "text.secondary",
              }}
            />
            <Typography variant="body2" sx={{ fontWeight: 700, mt: 0.5, lineHeight: 1.2 }}>
              {s.code}
              {s.layover != null && (
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: 0.5, fontWeight: 500 }}
                >
                  {formatDuration(s.layover)}
                </Typography>
              )}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** Total trip time: the row's own figure when a source gave one, else the span
 *  from first departure to last arrival. Both are local times at different
 *  airports, so this is only right when they carry offsets — which is why the
 *  stored `duration_minutes` wins whenever it exists. */
function totalMinutes(f: Find, legs: Segment[]): number | null {
  if (f.duration_minutes) return f.duration_minutes;
  const dep = Date.parse(legs[0]?.departsAt ?? "");
  const arr = Date.parse(legs.at(-1)?.arrivesAt ?? "");
  if (Number.isNaN(dep) || Number.isNaN(arr) || arr <= dep) return null;
  return Math.round((arr - dep) / 60_000);
}

/**
 * A summary row: seats.aero said there is space at this price and nothing about
 * which aeroplane.
 *
 * Deliberately short rather than a full-height skeleton of em-dashes. Half a
 * wide route's rows can be summaries, and a page of placeholders reads as data
 * that failed to load rather than data nobody has bought yet. The enrich icon in
 * the actions column is the fix, and its tooltip already quotes the call cost.
 */
function SummaryStub({ f }: { f: Find }) {
  // `stop_count` is nullable on purpose, and NULL must never become a guess:
  // rendering one as "· 1 stop" claims the source said something it didn't.
  // Null here says "connecting, routing unknown", which is the actual answer.
  const stops = f.stop_count ?? (f.is_direct ? 0 : null);
  return (
    <Box sx={{ py: 0.5, minWidth: { xs: 0, sm: 300 }, maxWidth: CARD_MAX_WIDTH }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="caption" color="text.secondary">
          Summary — no itinerary yet
          {stops == null
            ? " · connecting, routing unknown"
            : ` · ${stops === 0 ? "nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`}`}
        </Typography>
        <Stack direction="row" spacing={0} sx={{ ml: "auto", alignItems: "center" }}>
          <EnrichControl f={f} labelled />
          <BookLink f={f} />
        </Stack>
      </Stack>
      <Box sx={{ opacity: 0.6 }}>
        <StopBar stops={[{ code: f.origin }, { code: f.destination }]} />
      </Box>
    </Box>
  );
}

/**
 * One leg's flight code, out to FlightAware when the code identifies a flight.
 *
 * The label is the natural handle for "what actually flies this?" — equipment,
 * on-time record, whether today's copy of it is in the air — and none of that is
 * anything this app stores or should. A leg whose code we only half know (a
 * carrier with no number, most partner-marketed space before enrichment) stays
 * plain text: same weight, same colour, no link that resolves to the wrong
 * aeroplane.
 */
function FlightCode({ s }: { s: Segment }) {
  const label = flightLabel(s) || "—";
  const url = flightAwareUrl(s);

  // The aeroplane is context rather than something to act on, so it rides in
  // the tooltip the link already has instead of widening a card capped at
  // CARD_MAX_WIDTH. A tooltip that only restated the visible code would be
  // noise, so it is built only when one of the two has something to add.
  const title = [url ? `Look up ${label} on FlightAware` : "", s.aircraft]
    .filter(Boolean)
    .join(" · ");

  const text = (
    <Typography
      variant="body2"
      color="primary"
      component={url ? "a" : "span"}
      {...(url ? { href: url, target: "_blank", rel: "noopener noreferrer" } : {})}
      sx={{
        fontWeight: 700,
        whiteSpace: "nowrap",
        ...(url && {
          color: "secondary.main",
          textDecoration: "none",
          "&:hover": { textDecoration: "underline" },
        }),
      }}
    >
      {label}
    </Typography>
  );

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "baseline" }}>
      {title ? <Tooltip title={title}>{text}</Tooltip> : text}
      {s.fareClass && <FareClass code={s.fareClass} />}
    </Stack>
  );
}

/**
 * The booking class the seat came out of.
 *
 * Shown rather than tucked into a tooltip: it is one character, and it is the
 * thing you read back to an agent when a website disagrees about whether the
 * award exists. Hiding it would defeat the reason it is stored at all.
 */
function FareClass({ code }: { code: string }) {
  return (
    <Tooltip title={`Booking class ${code} — the award bucket this seat came from`}>
      <Box
        component="span"
        sx={{
          px: 0.5,
          borderRadius: 0.5,
          border: 1,
          borderColor: "divider",
          color: "text.secondary",
          fontSize: 11,
          lineHeight: 1.5,
          fontWeight: 700,
          cursor: "help",
        }}
      >
        {code}
      </Box>
    </Tooltip>
  );
}

/**
 * The find's real legs, or an empty array if it is still a summary.
 *
 * A leg is real when it NAMES A FLIGHT — not when we happen to know its clock.
 *
 * A trip embedded in a search response carries only the whole trip's
 * endpoints, so a SFO-SEA-NRT itinerary arrives with a time on its first
 * departure and its last arrival and none in between. Filtering on
 * `departsAt` instead would keep leg one and silently draw a two-leg award
 * as a nonstop to the wrong city.
 *
 * Exported because the route map beside the card has to draw the same routing
 * the card does. Two copies of this predicate would eventually disagree, and the
 * disagreement would look like the map being wrong about a real itinerary.
 */
export function itineraryLegs(f: Find): Segment[] {
  return parseSegments(f.segments_json).filter((s) => s.departsAt || s.flightNumber);
}

/**
 * Every airport the find touches, in order — the stop bar's nodes as bare codes.
 *
 * A summary falls back to its endpoints, which is the honest answer: the source
 * said there is space between these two airports and nothing about how.
 */
export function findStops(f: Find): string[] {
  const legs = itineraryLegs(f);
  if (!legs.length) return [f.origin, f.destination];
  return [legs[0]!.from, ...legs.map((leg) => leg.to)];
}

export function ItineraryCard({ f }: { f: Find }) {
  const legs = itineraryLegs(f);

  // Nothing named and nothing timed: a summary, which has its own short form.
  if (legs.length === 0) return <SummaryStub f={f} />;

  const first = legs[0]!;
  const finalLeg = legs.at(-1)!;
  const total = totalMinutes(f, legs);
  const plus = dayOffset(f.flight_date, finalLeg.arrivesAt);

  const stops: Stop[] = [
    { code: first.from },
    ...legs.slice(0, -1).map((leg, i) => ({
      code: leg.to,
      layover: layoverMinutes(leg.arrivesAt, legs[i + 1]!.departsAt),
    })),
    { code: finalLeg.to },
  ];

  return (
    <Box sx={{ py: 0.75, minWidth: { xs: 0, sm: 300 }, maxWidth: CARD_MAX_WIDTH }}>
      {/* useFlexGap so the spacing is `gap`, not a margin-left rule whose
          specificity would beat the duration's `ml: auto`. */}
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        {legs.map((s, i) => (
          <Stack key={i} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <AirlineLogo code={s.carrier} />
            <FlightCode s={s} />
          </Stack>
        ))}
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          {total != null && (
            <Typography variant="body2" color="text.secondary">
              {formatDuration(total)}
            </Typography>
          )}
          <Stack direction="row" spacing={0} sx={{ alignItems: "center" }}>
            <EnrichControl f={f} />
              <BookLink f={f} />
          </Stack>
        </Stack>
      </Stack>

      <Stack direction="row" sx={{ alignItems: "center", mt: 0.5 }}>
        <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {/* An em-dash, not a blank: a leg whose clock we don't know still has
              a row, and an empty cell reads as a rendering failure. */}
          {clockTime12(first.departsAt) || "—"}
        </Typography>
        <Box sx={{ flex: 1, textAlign: "center" }}>
          <FlightRoundedIcon
            fontSize="small"
            sx={{ color: "text.disabled", transform: "rotate(90deg)" }}
          />
        </Box>
        {/* No arrival DATE here — the Date column already carries the day, and on
            everything but a red-eye it was the same one twice. The `+N` is what
            that column can't say, so it stays. */}
        <Typography
          variant="h6"
          sx={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
        >
          {clockTime12(finalLeg.arrivesAt) || "—"}
          {plus > 0 && (
            <Tooltip title={`Lands ${dayLabel(finalLeg.arrivesAt)}`}>
              <Typography
                component="span"
                variant="caption"
                color="warning.main"
                sx={{ ml: 0.5, verticalAlign: "super", fontWeight: 700, cursor: "help" }}
              >
                +{plus}
              </Typography>
            </Tooltip>
          )}
        </Typography>
      </Stack>

      <StopBar stops={stops} />
    </Box>
  );
}
