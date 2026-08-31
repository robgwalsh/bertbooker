// The date-range bar's arithmetic and its vocabulary, with no React in it.
//
// A `.ts` beside its only consumer for the same reason `findKey.ts` is one:
// `vitest.config.ts` globs `*.test.ts` only, so a pure function that lives
// inside a `.tsx` is a function no test can reach.

import type { ChunkState } from "./useRouteSearch";

/**
 * What each chunk status means to a person reading the panel.
 *
 * The distinction this table encodes is the one the whole architecture is built
 * around: `empty` is an answer ("nobody is selling award space on these dates"),
 * everything below it is the absence of an answer. They produce identical
 * results and must never read alike, because only `empty` licenses believing it.
 * Mirrors `SourceTaskStatus`, declared in shared/src/wire/domain.ts.
 */
export const CHUNK_STATUS: Record<
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

/**
 * How a range paints in the bar.
 *
 * Five tones rather than the four icon kinds, because the bar has to separate
 * the two things the icons collapse: a range that FOUND something and a range
 * that looked and found nothing are both answers, but only one of them is a
 * reason to look at the table below. `gap` is the tone that must never be
 * confused with `answered` — see the note on `CHUNK_STATUS`.
 */
export type ChunkTone = "found" | "answered" | "gap" | "running" | "pending";

export function chunkTone(chunk: Pick<ChunkState, "status" | "offersFound">): ChunkTone {
  switch (chunk.status) {
    case "running":
      return "running";
    case "pending":
    case "skipped":
      return "pending";
    case "ok":
      // `ok` with nothing kept reads as `empty` to a person: the call worked and
      // there is no award space to show for it.
      return (chunk.offersFound ?? 0) > 0 ? "found" : "answered";
    case "empty":
      return "answered";
    default:
      return "gap";
  }
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Days since the epoch for a bare `YYYY-MM-DD`. Through `Date.UTC` on the parsed
 *  parts and never through a local-time `Date`, which would shift the calendar
 *  day west of Greenwich — the same trap `dates.ts` and `lib/format.ts` guard. */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Inclusive day count: a chunk running 3/1–3/1 is one day, not zero. */
export function daysInclusive(start: string, end: string): number {
  const n = dayNumber(end) - dayNumber(start) + 1;
  return Number.isFinite(n) ? n : 0;
}

/** `"Mar–May"`, or `"Mar"` when a range sits inside one month. The exact dates
 *  are on the tooltip and at the two ends of the bar; this only has to say
 *  roughly where in the year a segment is. */
export function rangeLabel(start: string, end: string): string {
  const a = Number(start.split("-")[1]);
  const b = Number(end.split("-")[1]);
  const from = MONTHS[a - 1];
  const to = MONTHS[b - 1];
  if (!from || !to) return "";
  return from === to ? from : `${from}–${to}`;
}

/** Below this share of the span, a segment is narrower than its own label.
 *  The last chunk of a year is routinely 6 days against 90, so this fires. */
export const LABEL_MIN_FRACTION = 0.12;

export interface TimelineSegment {
  index: number;
  start: string;
  end: string;
  /** Inclusive, and the segment's flex weight — chunks are NOT equal width. A
   *  366-day window plans as 90/90/90/90/6. */
  days: number;
  fraction: number;
  tone: ChunkTone;
  /** The chunk narrowed its own coverage claim (paginated out). A partial
   *  answer, not a failure — so it keeps its tone and gets marked separately. */
  narrowed: boolean;
  label: string;
  showLabel: boolean;
}

export interface Timeline {
  segments: TimelineSegment[];
  spanStart: string;
  spanEnd: string;
  totalDays: number;
}

/**
 * The planned chunks as a proportional bar over the window actually searched.
 *
 * The span is the plan's own first start to its own last end, which is the
 * CLAMPED window (`effectiveSearchWindow` cuts a tracked route back to
 * `[today, today + 365]`) — that is the honest thing to draw, because it is what
 * the search is going to look at.
 */
export function timelineSegments(tasks: ChunkState[]): Timeline {
  const chunks = mergeByRange(tasks);
  if (chunks.length === 0) {
    return { segments: [], spanStart: "", spanEnd: "", totalDays: 0 };
  }
  const spanStart = chunks[0]!.start;
  const spanEnd = chunks[chunks.length - 1]!.end;
  const days = chunks.map((c) => Math.max(1, daysInclusive(c.start, c.end)));
  const totalDays = days.reduce((n, d) => n + d, 0);

  return {
    spanStart,
    spanEnd,
    totalDays,
    segments: chunks.map((c, index) => {
      const d = days[index]!;
      const fraction = d / totalDays;
      return {
        index,
        start: c.start,
        end: c.end,
        days: d,
        fraction,
        tone: chunkTone(c),
        narrowed: Boolean(c.note),
        label: rangeLabel(c.start, c.end),
        showLabel: fraction >= LABEL_MIN_FRACTION,
      };
    }),
  };
}

/**
 * One task per DATE RANGE, worst answer winning.
 *
 * A route with hubs plans two queries per range — the hubs, then the hubs onward
 * — so `run.chunks` holds two tasks with identical dates. This bar is a picture
 * of the WINDOW, and drawing a range twice would tell the reader the search
 * covers twice as many days as it does.
 *
 * Worst-wins rather than first-wins, and it has to be: if the outbound query
 * answered and the inbound one failed, the range is not covered, and painting it
 * as answered is the one thing this bar exists not to do. `offersFound` sums,
 * because a find from either query is a find in that range. The calls dialog
 * still shows the queries separately — that is where the per-query detail
 * belongs.
 */
function mergeByRange(tasks: ChunkState[]): ChunkState[] {
  const byRange = new Map<string, ChunkState>();
  for (const task of tasks) {
    const key = `${task.start}..${task.end}`;
    const seen = byRange.get(key);
    if (!seen) {
      byRange.set(key, task);
      continue;
    }
    byRange.set(key, {
      ...seen,
      status: worseStatus(seen.status, task.status),
      offersFound: (seen.offersFound ?? 0) + (task.offersFound ?? 0),
      // A narrowed claim on EITHER query narrows the range.
      note: seen.note ?? task.note,
    });
  }
  return [...byRange.values()];
}

/** Which of two task outcomes a reader should be shown for one range. The order
 *  is `CHUNK_STATUS`'s own argument: `empty` is an answer and everything below
 *  it is the absence of one, so an absence always wins. */
function worseStatus(a: ChunkState["status"], b: ChunkState["status"]): ChunkState["status"] {
  const rank: Record<ChunkState["status"], number> = {
    ok: 0,
    empty: 1,
    running: 2,
    pending: 3,
    skipped: 4,
    timeout: 5,
    challenged: 6,
    blocked: 7,
    failed: 8,
  };
  return rank[b] > rank[a] ? b : a;
}

/** Ranges the search asked about and got no answer for. These are the ones the
 *  finds table cannot show, because an absent row looks the same as no space. */
export function gapRanges(chunks: ChunkState[]): ChunkState[] {
  return mergeByRange(chunks).filter((c) => chunkTone(c) === "gap");
}

/** Ranges nobody ever got to. Only meaningful once a run has settled — while it
 *  is running these are simply the ones still queued. */
export function uncheckedRanges(chunks: ChunkState[]): ChunkState[] {
  return mergeByRange(chunks).filter((c) => c.status === "pending" || c.status === "skipped");
}
