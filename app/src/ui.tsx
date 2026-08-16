import { useState } from "react";
import { Box, Chip, Stack, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import { readable } from "./theme";
import { AIRLINE_ICAO } from "./data/airlineIcao";
import { ALERT_HEALTH, alertHealth } from "./alerts";
import type { AlertScheduleRoute, Find, Segment } from "./api";

// Small presentation helpers shared across pages so labels/colors stay consistent.

/** The page container's vertical padding, in theme spacing units (→ 20px).
 *  Exported because `STICKY_NAV_TOP` is derived from it — see below. */
export const PAGE_PY = 2.5;

/** The page container's horizontal padding, per breakpoint.
 *
 *  Lives here rather than in `router.tsx` because the shell no longer applies
 *  it: since the Routes page became a full-bleed workbench, padding is a
 *  PAGE's decision, and `PagePad` is the one place the pages that still want it
 *  get it. */
export const GUTTERS = { xs: 1.5, sm: 2, lg: 3 };

/** The app bar's height: a 40px title-bar/tab strip plus the rule under it.
 *
 *  Fixed at every breakpoint, unlike MUI's Toolbar — `Layout` pins the
 *  `minHeight` rather than letting it shrink on a landscape phone, precisely so
 *  `STICKY_NAV_TOP` below is a true number on every screen instead of only from
 *  `md` up. */
export const APP_BAR_HEIGHT = 41;

/** Where the Library's tab column pins.
 *
 *  It is *exactly where that nav already sits* unscrolled: past its scroller's
 *  top padding. Pinning any higher means the nav jumps up by the difference the
 *  moment the page moves, which reads as a nav that doesn't hold its place
 *  rather than as a page sliding underneath one that does.
 *
 *  **No `APP_BAR_HEIGHT` term any more, and that is the point.** The document
 *  itself no longer scrolls — `Layout` is a fixed-height column and each page
 *  owns a scroll container inside it (`PagePad` here) — so a sticky child is
 *  offset from ITS SCROLLER's top edge, which already starts below the tab
 *  strip. Adding the bar's height back would push the column down by 41px the
 *  instant anything scrolled.
 *
 *  A nav is only pinned from `md` up — a pinned column is worth little on a
 *  screen narrower than that. The Routes rail no longer uses this at all: it is
 *  a full-height pane with its own scrollbar, which is what a sidebar is. */
export const STICKY_NAV_TOP = 8 * PAGE_PY;

// The app's TWO named viewport seams, and the only `useMediaQuery` calls in it.
//
// They live here, named, rather than as `down("sm")` sprinkled through the
// pages, because the difference between the two is easy to get wrong and
// invisible when you do. Prefer an `sx` breakpoint object wherever the
// difference is purely visual — these are for when the DOM itself has to change,
// which is a much smaller set than it first looks.
//
// `noSsr` on both: this is a client-only SPA rendered with `createRoot`, so the
// query can be evaluated before first paint instead of assuming `false` and
// correcting in an effect. Without it a phone paints the desktop table for a
// frame and then throws it away.

/**
 * Below `sm` — a phone held upright, and the width at which the finds tables
 * stop being tables.
 *
 * Two things here cannot be expressed as styles, which is the whole reason this
 * is a hook and not a breakpoint object:
 * - The wide tables become **cards**: different markup, not restyled cells.
 *   `RoundTripTable` straddles cells with `rowSpan={2}`, and the usual CSS-only
 *   `display: block` responsive-table trick discards `rowSpan` outright — a
 *   trip's cabin, nights, seats and total would each print twice.
 * - `QuotaIndicator` is *unrendered* rather than hidden (see `Layout`), because
 *   a `display: none` element still measures, and something measures that one.
 */
export function useIsPhone(): boolean {
  return useMediaQuery((t: Theme) => t.breakpoints.down("sm"), { noSsr: true });
}

/**
 * Below `md` — too narrow to hold a pinned column beside the content it
 * navigates.
 *
 * The seam this app already had before any of this: the Routes workbench grid
 * collapses here, and `STICKY_NAV_TOP`'s docblock says outright that "a nav is
 * only pinned from `md` up". Both of the app's two-pane layouts — the Routes
 * rail beside its editor, and Library's tab column beside its panel — show ONE
 * pane at a time below this width.
 *
 * Distinct from `useIsPhone` because a 700px tablet has no room for a sidebar
 * and plenty of room for a table.
 */
export function useIsNarrow(): boolean {
  return useMediaQuery((t: Theme) => t.breakpoints.down("md"), { noSsr: true });
}

/**
 * The padded, scrolling page body — what a page that is a DOCUMENT sits in.
 *
 * `Layout` deliberately does not pad or scroll: the Routes page is a workbench
 * that runs edge to edge with its own panes, and a shell that padded everything
 * would have to be fought with negative margins to get there. So the shell
 * hands each page a full-height box and the pages that want a margin ask for
 * one here.
 *
 * It is also the scroll container, which is what keeps exactly one scrollbar on
 * screen: the document can't scroll (`html, body, #root` are all 100%), so a
 * page that didn't scroll internally would simply clip.
 */
export function PagePad({ children }: { children: React.ReactNode }) {
  return (
    // This box owns BOTH axes. `overflowY` was always here; `overflowX` matters
    // because the document itself cannot scroll (`html, body, #root` are 100%),
    // so without a scroller of its own a child wider than the viewport paints
    // off the edge of the screen with nothing anywhere that can reach it.
    //
    // `auto` rather than `hidden`, and the difference is about how a future
    // mistake surfaces: clipping would HIDE an over-wide child, including from
    // `e2e/mobile.spec.ts`, which catches exactly this by comparing
    // `scrollWidth` to `clientWidth`. Scrolling makes the same mistake visible
    // in the app and fails the test. Nothing should be reaching it today — the
    // wide tables carry their own `TableContainer` scroller and become cards on
    // a phone — so this is a backstop, not a layout.
    <Box sx={{ height: "100%", overflowY: "auto", overflowX: "auto", py: PAGE_PY, px: GUTTERS }}>
      {children}
    </Box>
  );
}

/**
 * The left margin a small `Switch` in a `FormControlLabel` needs to line its
 * track up with the fields or text beside it.
 *
 * `FormControlLabel` hangs its control by a flat -11px, which is tuned for a
 * DEFAULT-size Switch: that one carries 12px of padding around its 34px track,
 * so -11 lands the visible track a pixel inside the content edge. A small Switch
 * pads by 7, so the same -11 overhangs to the left of every field in the form —
 * which is what it looked like. Matching the padding puts the track exactly on
 * the edge.
 *
 * Shared rather than redefined: it is a tuned number about MUI's internals, and
 * a second copy is how the route form and the preferences dialog would end up
 * a few pixels apart.
 */
export const SWITCH_ROW_ML = "-7px";

export const CURRENCY_LABEL: Record<string, string> = {
  chase_ur: "Chase",
  capital_one: "Cap One",
  bilt: "Bilt",
  citi_ty: "Citi",
  direct: "Direct",
};

/**
 * The sentinel for "this one has no colour of its own".
 *
 * A palette map is module-scope data and can't call `useTheme`, so the neutral
 * member of each map below is spelled with this and swapped for the live
 * `text.secondary` by `resolveColor` at render. Without it, every
 * "none / unknown / economy" swatch stayed the old dark theme's slate grey —
 * legible on near-black, nearly invisible on Light+.
 *
 * Declared before its first use because these maps are initialized at module
 * load: a `const` referenced above its declaration is a ReferenceError, not a
 * hoist.
 */
export const NEUTRAL_COLOR = "neutral";

/** A palette entry as a colour to paint with, given the live theme. */
export function resolveColor(color: string, mutedColor: string): string {
  return color === NEUTRAL_COLOR ? mutedColor : color;
}

// Accent per transfer currency — the fallback mark's color, and the accent for
// the few places a currency is still named in text.
//
// These stay literal through every theme, and that is the point: they are how
// you tell Chase from Bilt at a glance in a dense row, so they have to mean the
// same thing in Solarized Light as in Dracula. The one exception is `direct`,
// which is not a brand — it is the absence of one.
export const CURRENCY_COLOR: Record<string, string> = {
  chase_ur: "#4f8cff",
  capital_one: "#ff6b6b",
  bilt: "#38e0c8",
  citi_ty: "#c084fc",
  direct: NEUTRAL_COLOR,
};

/** Wallet order, so a row of currency icons reads left-to-right the same
 *  everywhere. Cheap with text labels, load-bearing without them: an icon's
 *  *position* is the only thing left to recognize it by at a glance. */
export function sortCurrencies(codes: string[]): string[] {
  const order = Object.keys(CURRENCY_LABEL);
  return [...codes].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

/** The issuer site behind each currency — the mark `CurrencyIcon` draws.
 *
 *  `direct` (book in the program's own miles, no transfer) has no issuer and is
 *  absent on purpose: it falls through to the colored dot. */
const CURRENCY_DOMAIN: Record<string, string> = {
  chase_ur: "chase.com",
  capital_one: "capitalone.com",
  bilt: "biltrewards.com",
  citi_ty: "citi.com",
};

export const faviconUrl = (domain: string) => `https://icons.duckduckgo.com/ip3/${domain}.ico`;

/**
 * A transfer currency as its issuer's mark — the one shape every "who can book
 * this" surface uses.
 *
 * It replaced a text chip, and the lost name is what that cost: four chips
 * reading Chase / Cap One / Bilt / Citi were among the widest cells in a finds
 * row and the least varied, but a card you recognize by its logo needs no word
 * beside it. So **the tooltip is the label, not decoration** — it is built in
 * here rather than left to callers, because an unnamed mark in a row that never
 * spells the name out is unreadable to anyone who doesn't already know it.
 *
 * The footprint is fixed whether the favicon resolves or not — the fallback dot
 * centres inside the same square — so a column of these stays aligned instead
 * of jittering row to row.
 */
export function CurrencyIcon({
  code,
  size = 22,
  note,
}: {
  code: string;
  size?: number;
  /** Extra clause for the tooltip, e.g. a filter's meaning or a transfer ratio.
   *  It joins the name rather than replacing it, and it is why callers don't wrap
   *  these in a Tooltip of their own — nested tooltips fire together. */
  note?: string;
}) {
  const [broken, setBroken] = useState(false);
  const theme = useTheme();
  const name = CURRENCY_LABEL[code] ?? code;
  const label = note ? `${name} — ${note}` : name;
  const color = readable(
    resolveColor(CURRENCY_COLOR[code] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
    theme,
  );
  const domain = CURRENCY_DOMAIN[code];
  const showIcon = Boolean(domain) && !broken;
  return (
    <Tooltip title={label}>
      {/* `role="img"` so the name survives for a screen reader too: without it
          the label lives only in a hover tooltip, and the cell announces as an
          empty div. */}
      <Box
        role="img"
        aria-label={label}
        sx={{
          width: size,
          height: size,
          borderRadius: `${Math.round(size * 0.26)}px`,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          // Issuer favicons are drawn for white backgrounds, so the tile stays
          // white in every theme — it is the mark's own paper, not a surface of
          // ours. Only its edge follows the theme, which is what keeps a white
          // tile from dissolving into a light theme's near-white page.
          bgcolor: showIcon ? "#ffffff" : "transparent",
          border: showIcon ? `1px solid ${theme.palette.divider}` : "none",
        }}
      >
        {showIcon ? (
          <Box
            component="img"
            src={faviconUrl(domain!)}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            sx={{ width: size * 0.7, height: size * 0.7, objectFit: "contain" }}
          />
        ) : (
          <Box
            sx={{
              width: size * 0.45,
              height: size * 0.45,
              borderRadius: "50%",
              bgcolor: color,
              boxShadow: `0 0 ${size * 0.36}px ${alpha(color, 0.7)}`,
            }}
          />
        )}
      </Box>
    </Tooltip>
  );
}

// Airport type → label + accent color. Shared by the Airports table chips and the
// airport map's dot colors/legend so the palette stays in one place.
export const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  large_airport: { label: "Large", color: "#7c8cff" },
  medium_airport: { label: "Medium", color: "#38e0c8" },
  small_airport: { label: "Small", color: "#9aa3bd" },
  heliport: { label: "Heliport", color: "#f5c451" },
  seaplane_base: { label: "Seaplane", color: "#c084fc" },
  balloonport: { label: "Balloon", color: "#f5c451" },
};

/** Square carrier logo by IATA code, from Kiwi's public image CDN.
 *
 *  Keyed on the code the segment already carries, so — unlike a hand-maintained
 *  domain→favicon map — a regional operator flying a single leg (Envoy, SkyWest,
 *  Republic) still gets a real mark. Unknown codes redirect to a generic plane
 *  tile rather than 404ing, so onError is a backstop for network failure rather
 *  than the normal miss path. */
const airlineLogoUrl = (iata: string) =>
  `https://images.kiwi.com/airlines/64x64/${iata}.png`;

/**
 * A carrier's logo, sized to sit inline to the left of a flight code.
 *
 * The footprint is fixed whether or not the image resolves, so flight numbers
 * stay aligned down the column instead of jittering row to row.
 */
export function AirlineLogo({ code, size = 18 }: { code?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const theme = useTheme();
  const carrier = code && /^[A-Z0-9]{2}$/i.test(code) ? code.toUpperCase() : undefined;
  const showIcon = Boolean(carrier) && !broken;
  return (
    <Box
      title={carrier}
      sx={{
        width: size,
        height: size,
        borderRadius: 0.75,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        // The tiles are drawn on white, so they keep their paper (see
        // `CurrencyIcon`); the fallback square and every edge follow the theme.
        bgcolor: showIcon ? "#ffffff" : alpha(theme.palette.text.secondary, 0.14),
        border: `1px solid ${theme.palette.divider}`,
      }}
    >
      {showIcon ? (
        <Box
          component="img"
          src={airlineLogoUrl(carrier!)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          sx={{ width: size, height: size, objectFit: "contain" }}
        />
      ) : (
        <FlightRoundedIcon sx={{ fontSize: size * 0.62, color: "text.disabled" }} />
      )}
    </Box>
  );
}

/**
 * A segment's display code, e.g. "AS 505".
 *
 * `flightNumber` is not normalized: seats.aero returns it carrier-prefixed
 * ("AA4457"), and sources this app has carried before returned bare digits
 * ("505"). Joining blindly gives "AA AA4457", so strip a leading copy of the
 * carrier before joining. Kept tolerant of both because the stored rows are.
 */
export function flightLabel(s: Segment): string {
  const carrier = (s.carrier ?? "").toUpperCase();
  const raw = (s.flightNumber ?? "").trim();
  const num =
    carrier && raw.toUpperCase().startsWith(carrier) ? raw.slice(carrier.length).trim() : raw;
  return [carrier, num].filter(Boolean).join(" ");
}

/**
 * FlightAware's page for a leg, or undefined when there is nothing to look up.
 *
 * Built off `flightLabel` so the link and the text it sits under can never
 * disagree about which flight this is — but the ident it links to is NOT the
 * label. FlightAware canonicalizes on the **ICAO** carrier code, so Delta's
 * DL5678 is its DAL5678; it does not resolve the IATA form for us, and the old
 * comment here claiming it did is why every Delta link was dead. `AIRLINE_ICAO`
 * is the translation, and adding a row is how a specific broken carrier gets
 * fixed.
 *
 * A carrier we don't map falls through to the IATA ident unchanged, which is
 * what the app did for everyone before: FlightAware answers some of those and
 * not others, so it is best effort rather than a promise. A three-character
 * carrier falls through too — nothing in this app emits one, but if a source
 * ever does it is already ICAO.
 *
 * Both halves are required. A carrier with no number is not a flight, and a
 * bare number with no carrier resolves to whichever airline FlightAware guesses
 * — a link to the wrong aeroplane is worse than no link.
 */
export function flightAwareUrl(s: Segment): string | undefined {
  const parts = flightLabel(s).split(" ");
  if (parts.length !== 2) return undefined;
  const [carrier = "", num = ""] = parts;
  const ident = `${AIRLINE_ICAO[carrier] ?? carrier}${num}`;
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(ident)) return undefined;
  return `https://www.flightaware.com/live/flight/${ident}`;
}

// Cabin rank as colour: gold, indigo, teal, and none. Literal for the same
// reason `CURRENCY_COLOR` is — business has to be the same colour in every
// theme or the column stops being scannable — except economy, which is the
// bottom of the ladder and should read as unmarked.
const CABIN_COLOR: Record<string, string> = {
  first: "#f5c451",
  business: "#7c8cff",
  premium: "#38e0c8",
  economy: NEUTRAL_COLOR,
};

export function CabinChip({ cabin }: { cabin: string }) {
  const theme = useTheme();
  const color = readable(
    resolveColor(CABIN_COLOR[cabin] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
    theme,
  );
  return (
    <Chip
      size="small"
      label={cabin}
      sx={{
        textTransform: "capitalize",
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    />
  );
}

/**
 * Which currencies can book this, as issuer marks.
 *
 * Takes the raw `transfer_currencies` blob rather than a parsed list because
 * every caller has it in that form, and a malformed one renders an em-dash
 * rather than throwing — "we don't know who can book it" is a legitimate cell.
 */
export function BookableCurrencies({
  json,
  size,
  note,
}: {
  json?: string;
  size?: number;
  note?: string;
}) {
  let codes: string[] = [];
  try {
    codes = json ? (JSON.parse(json) as string[]) : [];
  } catch {
    codes = [];
  }
  if (codes.length === 0)
    return (
      <Typography component="span" color="text.disabled">
        —
      </Typography>
    );
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {sortCurrencies(codes).map((c) => (
        <CurrencyIcon key={c} code={c} size={size} note={note} />
      ))}
    </Stack>
  );
}

// Consistent responsive grid wrapper (avoids MUI <Grid> API churn across majors).
// Currently unused — its only caller was a Point balances section on what is now
// the Routes page.
// Kept because it is the house answer to "lay out N cards" and the next thing
// that needs one should not re-derive the auto-fill/minmax incantation.
export function CardGrid({
  min = 200,
  children,
}: {
  min?: number;
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gap: 2,
        gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
      }}
    >
      {children}
    </Box>
  );
}

export function miles(n: number) {
  return n.toLocaleString() + " mi";
}

export function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The cheapest way to pay a CASH fare with points, across the currencies the
 * couple holds.
 *
 * Mirrors `bestPointsForCash` in shared/src/data/programs.ts, but reads
 * its rates from `api.currencies()` rather than a second hardcoded copy — so the
 * portal rate lives in exactly one place even though the conversion happens on
 * the client. Returns undefined when there's no fare or no portal rate.
 */
export function bestPortalPrice(
  cents: number | null | undefined,
  currencies: { code: string; portalCentsPerPoint?: number }[] | undefined,
): { code: string; points: number } | undefined {
  if (cents == null || !Number.isFinite(cents) || cents <= 0 || !currencies) return undefined;
  let best: { code: string; points: number } | undefined;
  for (const c of currencies) {
    if (!c.portalCentsPerPoint) continue;
    const points = Math.ceil(cents / c.portalCentsPerPoint);
    if (!best || points < best.points) best = { code: c.code, points };
  }
  return best;
}

// Google Flights search for a route + date — the fallback when a result has no
// airline booking link (e.g. summary-only results whose detail fetch failed).
export function flightSearchUrl(f: {
  origin: string;
  destination: string;
  flight_date: string;
}): string {
  const q = `Flights from ${f.origin} to ${f.destination} on ${f.flight_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

// Where a find's "book" button should point: the airline/program's own award
// page, when the source gave us one, else a Google Flights
// search. Returns the target URL plus a short label for the destination host.
export function bookingTarget(f: Find): { url: string; label: string; isAirline: boolean } {
  if (f.booking_url) {
    let host = "airline site";
    try {
      host = new URL(f.booking_url).hostname.replace(/^www\./, "");
    } catch {
      /* keep fallback label */
    }
    return { url: f.booking_url, label: `Book on ${host}`, isAirline: true };
  }
  return { url: flightSearchUrl(f), label: "Search on Google Flights", isAirline: false };
}

/**
 * A route's alert state as a chip. Lives here rather than on the Alerts tab
 * because three surfaces draw it now — that tab's table, and the Routes page's
 * header — and a second copy is a second opinion about what "failing" means.
 *
 * The words, the colour and the ladder behind them are all `alerts.ts`; this is
 * only the chip.
 */
export function AlertStateChip({ route }: { route: AlertScheduleRoute }) {
  const state = ALERT_HEALTH[alertHealth(route)];
  return (
    <Tooltip title={state.help}>
      <Chip size="small" variant="outlined" color={state.chipColor} label={state.label} />
    </Tooltip>
  );
}

/** "3d ago" / "just now" / "never". Coarse on purpose — this is a freshness
 *  signal, not a timestamp, and to the minute would imply a precision that a
 *  human-triggered search doesn't have. */
export function sinceLabel(ms?: number | null): string {
  if (!ms) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Minutes → "17h 35m" / "45m". Returns "" for missing/zero.
export function formatDuration(min?: number | null): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// Day offset of an ISO local timestamp vs an itinerary's departure date, e.g. a
// red-eye landing the next day → 1. Returns 0 when unknown or same-day.
export function dayOffset(flightDate: string, arrivesAt?: string): number {
  if (!arrivesAt || arrivesAt.length < 10) return 0;
  const dep = Date.parse(flightDate + "T00:00:00");
  const arr = Date.parse(arrivesAt.slice(0, 10) + "T00:00:00");
  if (Number.isNaN(dep) || Number.isNaN(arr)) return 0;
  return Math.max(0, Math.round((arr - dep) / 86_400_000));
}

// Layover in minutes between a leg's arrival and the next leg's departure (both
// ISO local at the connecting airport). null when either side is missing.
export function layoverMinutes(
  prevArrivesAt?: string,
  nextDepartsAt?: string,
): number | null {
  if (!prevArrivesAt || !nextDepartsAt) return null;
  const a = Date.parse(prevArrivesAt);
  const b = Date.parse(nextDepartsAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const m = Math.round((b - a) / 60_000);
  return m > 0 ? m : null;
}

// Parse a stored segments_json blob defensively (never throws).
export function parseSegments(json?: string): Segment[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as Segment[]) : [];
  } catch {
    return [];
  }
}

// "2026-08-06T11:21:00" → "11:21am". Read off the string rather than parsed,
// because these are LOCAL times at their own airport with no offset attached —
// handing one to `Date` would shift it by the viewer's timezone and land a Tokyo
// arrival on the wrong clock. Best-effort; returns "" if unparseable.
export function clockTime12(iso?: string): string {
  if (!iso || iso.length < 16) return "";
  const h = Number(iso.slice(11, 13));
  const m = iso.slice(14, 16);
  if (!Number.isInteger(h) || h < 0 || h > 23) return "";
  return `${((h + 11) % 12) + 1}:${m}${h < 12 ? "am" : "pm"}`;
}

// "2026-10-09" (or a full ISO local timestamp) → "Fri, Oct 9", with the year
// appended once it isn't the current one ("Sat, Jan 3, 2027"). A tracked route's
// window is a full twelve months, so a bare month and day is genuinely ambiguous
// at the far end of it — but carrying the year on every row to say so would cost
// more than it tells you.
//
// Built through Date.UTC and rendered in UTC so the calendar day survives — the
// same timezone-shift trap `usDate` on the Routes page guards against.
export function dayLabel(iso?: string): string {
  if (!iso || iso.length < 10) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: y === new Date().getFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/**
 * What the Date column reserves, in both tables.
 *
 * A constant rather than the column's natural width, because `dayLabel`'s output
 * is not a fixed length — "Fri, Oct 9" against "Sat, Jan 3, 2027" — so a
 * content-sized column is as wide as whichever dates a given route happens to
 * hold, and every column to its right jumps sideways when you select a different
 * route. Wide enough for the longest form the label can produce, at this app's
 * 13px density and a cell's 16px of padding either side.
 *
 * Shared so the one-way and round-trip tables can't disagree: they run the same
 * columns in the same order precisely so they read alike.
 */
export const DATE_CELL_WIDTH = 148;

// ISO 3166-1 alpha-2 → flag emoji (regional-indicator symbols).
export function flagEmoji(country?: string | null): string {
  if (!country || country.length !== 2 || !/^[A-Za-z]{2}$/.test(country)) return "";
  const base = 0x1f1e6;
  const cc = country.toUpperCase();
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - 65),
    base + (cc.charCodeAt(1) - 65),
  );
}

// ISO 3166-1 alpha-2 → English country name via the browser's Intl.DisplayNames
// (no bundled country dataset). Falls back to the raw code.
const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function countryName(country?: string | null): string {
  if (!country) return "";
  try {
    return regionNames?.of(country.toUpperCase()) ?? country;
  } catch {
    return country;
  }
}
