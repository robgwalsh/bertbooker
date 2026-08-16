// Date-window math shared by every provider.
//
// Award sources all have the same two shapes of limit: a rolling horizon past
// which they have no data, and a maximum span (or result cap) per request. So
// every provider does the same two things — clamp the tracked window to its
// horizon, then tile the remainder into request-sized chunks. These helpers are
// pure and unit-tested so each provider only supplies its own constants.
//
// Extracted from a provider module rather than left inside one, and deliberately
// NOT re-exported from seatsaero.ts: providers/index.ts does `export *` from
// every provider module, and the same name exported by two modules silently
// disappears from the barrel.

/** Add `days` to an ISO (YYYY-MM-DD) date, returning ISO. UTC math keeps it
 *  DST/timezone-agnostic. */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today (UTC) as YYYY-MM-DD. Injectable `now` keeps callers testable. */
export function todayISO(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both ISO). Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  const toUtc = (iso: string) => {
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
