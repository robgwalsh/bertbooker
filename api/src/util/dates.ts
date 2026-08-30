// ISO date and date-window math. Pure, and unit-tested.
//
// Two shapes of limit turn up wherever a window is planned: a rolling horizon
// past which a source has no data, and a maximum span (or result cap) per
// request. So the same two things keep happening — clamp the tracked window to
// the horizon, then tile the remainder into request-sized chunks — and they live
// here so a caller supplies only its own constants.
//
// **The only module in `util/`, and the bar it sets.** This is here because it
// has no opinion about award travel at all — it is date arithmetic, and it would
// read the same in any application. Everything else that used to sit beside it
// DID have such an opinion, and went to the model it is about: which of two
// offers is better is `models/offer.ts`, what counts as a change is
// `models/change.ts`, what a route expands to is `models/route.ts`. If a thing
// proposed for this directory could not be lifted into an unrelated codebase
// unchanged, it belongs in `models/` instead.

/**
 * Is this the fixed-width `YYYY-MM-DD` every helper here and the schema assume?
 *
 * Load-bearing well beyond formatting. Dates are compared as STRINGS in SQL
 * (`flight_date BETWEEN ? AND ?`, `date_end < date_start`), and string
 * comparison only orders dates correctly at a fixed width; every helper below
 * parses by splitting on `-`. A value that is not this shape is not a date that
 * is slightly wrong — it is not a date, and it will compare and store without
 * complaint right up until something tries to do arithmetic on it.
 *
 * Character class rather than a shorthand escape on purpose: this must not match
 * the Unicode digits a shorthand would let through in some engines.
 */
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);
}

/**
 * Thrown when a value that has to be an ISO date is not one.
 *
 * Named, rather than the bare `RangeError: Invalid time value` that
 * `toISOString` used to raise from the middle of `addDaysISO`. That message
 * named neither the function nor the offending value, so a single malformed
 * `date_end` in `tracked_routes` surfaced as an opaque 500 on the Routes page —
 * and on every search, and on every cron tick — with nothing pointing here at
 * all. Extends `RangeError` so anything catching the old one still catches this.
 */
export class InvalidDateError extends RangeError {
  constructor(fn: string, value: unknown) {
    super(`${fn}: expected an ISO YYYY-MM-DD date, got ${JSON.stringify(value)}`);
    this.name = "InvalidDateError";
  }
}

/** Add `days` to an ISO (YYYY-MM-DD) date, returning ISO. UTC math keeps it
 *  DST/timezone-agnostic. Throws `InvalidDateError` rather than building an
 *  `Invalid Date` that only fails one line later, somewhere else. */
export function addDaysISO(iso: string, days: number): string {
  if (!isIsoDate(iso)) throw new InvalidDateError("addDaysISO", iso);
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today (UTC) as YYYY-MM-DD. Injectable `now` keeps callers testable. */
export function todayISO(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both ISO). Negative when b precedes a. Same guard
 *  as `addDaysISO`, because it parses identically: without it this returns `NaN`
 *  for a caller to compare or bind, which is the quieter half of the same bug. */
export function daysBetween(a: string, b: string): number {
  const toUtc = (iso: string) => {
    if (!isIsoDate(iso)) throw new InvalidDateError("daysBetween", iso);
    const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** Split an inclusive [start, end] date window into consecutive, non-overlapping
 *  sub-windows of at most `maxDays` each (endpoints reject wide spans). Capped
 *  at `maxChunks` sub-windows. Pure — unit-tested. */
export function chunkDateRange(
  start: string,
  end: string,
  maxDays: number,
  maxChunks: number,
): { start: string; end: string }[] {
  if (end < start) return [];
  const chunks: { start: string; end: string }[] = [];
  let cur = start;
  while (cur <= end && chunks.length < maxChunks) {
    const rawEnd = addDaysISO(cur, maxDays - 1);
    const chunkEnd = rawEnd > end ? end : rawEnd;
    chunks.push({ start: cur, end: chunkEnd });
    cur = addDaysISO(chunkEnd, 1);
  }
  return chunks;
}

/** Intersect a tracked [dateStart, dateEnd] window with a source's live, rolling
 *  horizon: never earlier than today, never later than today+horizon. Returns
 *  null when the tracked window lies entirely outside the horizon (a far-future
 *  route with nothing yet searchable). Pure — unit-tested. */
export function effectiveSearchWindow(
  dateStart: string,
  dateEnd: string,
  today: string,
  horizonDays: number,
): { start: string; end: string } | null {
  const start = dateStart > today ? dateStart : today;
  const horizonEnd = addDaysISO(today, horizonDays);
  const end = dateEnd < horizonEnd ? dateEnd : horizonEnd;
  return end < start ? null : { start, end };
}

/**
 * Pick discrete dates across a window when one request can only cover one date
 * and the window is far too wide to cover exhaustively.
 *
 * Dense-scans the first `scanDays` (near dates change most and matter most),
 * then samples the remainder every `stride` days. The sampling phase is derived
 * from `today` so consecutive runs walk a different offset and the whole far
 * window gets covered over `stride` runs.
 *
 * This is only safe because providers report `coverage()` — a run that skips a
 * date must not let the pipeline conclude that date's finds have vanished.
 */
export function planStrideDates(
  start: string,
  end: string,
  today: string,
  scanDays: number,
  stride: number,
  maxDates: number,
): string[] {
  if (end < start) return [];
  const out: string[] = [];
  const total = daysBetween(start, end);
  const phase = stride > 0 ? Math.abs(daysBetween("1970-01-01", today)) % stride : 0;

  for (let i = 0; i <= total && out.length < maxDates; i++) {
    const inDenseScan = i < scanDays;
    if (inDenseScan || (stride > 0 && (i - scanDays) % stride === phase % stride)) {
      out.push(addDaysISO(start, i));
    }
  }
  return out;
}
