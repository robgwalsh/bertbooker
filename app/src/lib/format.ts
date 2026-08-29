// Money, durations, clocks and calendar days — the formatting every dense row
// in this app goes through. Pure, no JSX, no React: that is what keeps it
// reachable by the `*.test.ts`-only vitest glob.
//
// The date functions here share one hazard and one rule. These are LOCAL times
// at their own airport, stored as strings with no offset attached, so anything
// that hands one to `Date` and reads it back shifts it by the VIEWER's timezone
// and lands a Tokyo arrival on the wrong clock. Read off the string, or build
// through `Date.UTC` and render in UTC.

export function miles(n: number) {
  return n.toLocaleString() + " mi";
}

/**
 * A count short enough for the app bar: 91_600 -> "91.6K", 5_000_000 -> "5M".
 *
 * The quota chips read `remaining/limit`, and `3,760,000/5,000,000` is
 * nineteen characters of a toolbar that already carries four tabs and three
 * controls. Only the D1 chips use this; the seats.aero one keeps
 * `toLocaleString()`, because four digits already fit and "842" is more useful
 * than "0.8K".
 */
export function compactCount(n: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * An award's taxes in the currency it is actually charged in.
 *
 * `dollars` assumes USD and most rows are, but not all: seats.aero quotes
 * Aeroplan in CAD and Korean Air out of Seoul in KRW, where a 2,400,000 figure
 * rendered through `dollars` reads as $24,029.90 instead of about $1,700. A
 * number that wrong is worse than no number, and it is the kind a reader acts on.
 *
 * Falls back to `dollars` for USD and for an unknown code, so nothing that was
 * right before changes. `Intl` does the minor-unit arithmetic, which is not
 * always /100 — JPY and KRW have no minor unit at all.
 */
export function money(cents: number, currency?: string | null): string {
  const code = (currency ?? "USD").toUpperCase();
  if (code === "USD") return dollars(cents);
  try {
    const digits = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      cents / 10 ** (digits === 0 ? 0 : 2),
    );
  } catch {
    return dollars(cents);
  }
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
