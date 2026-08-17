// The seats.aero constants and call records that the SPA needs to READ.
//
// These lived in `providers/seatsaero.ts` until the wire module existed, and
// moving them is not tidying — it is what makes `shared/src/wire/` importable at
// all. That file is 1436 lines and reaches `fetch`/`Headers`/`Response`, and two
// modules that look pure imported a single constant out of it:
// `routing.ts` and `alerts/pace.ts` both took `SEATSAERO_MAX_PAGES`. So
// `RoutePair` and `SweepPacing` transitively dragged the whole provider into
// whatever program touched them — including, once the SPA started importing this
// directory, the browser bundle.
//
// `providers/seatsaero.ts` re-exports everything here, so the root barrel's
// surface is unchanged and no `api/` import moved.

/**
 * The id this source writes into `availability_snapshots.source` and
 * `search_coverage.source`.
 *
 * DO NOT RENAME. It is a permanent database value: every row seats.aero has ever
 * written carries it, pruning is scoped by it, and a new name orphans all of them
 * — nothing would ever prune the old rows and they would sit there looking
 * current forever. The `api:` prefix records how the data is obtained (a keyed,
 * metered vendor API) and stays accurate now that the call happens on Cloudflare.
 */
export const SEATSAERO_SOURCE_ID = "seatsaero";

/** Days per chunk. Wide, because one call covers a range for free — but not the
 *  whole year at once, so a failure is attributable to part of the window rather
 *  than all of it. */
export const SEATSAERO_CHUNK_DAYS = 90;

/**
 * Ceiling on chunks per search.
 *
 * Five, not eight: `effectiveSearchWindow` already clamps the window to
 * `today + HORIZON_DAYS`, so at most 366 days survive planning and 5 × 90d covers
 * every one of them. Each chunk costs Worker subrequests, and the worst case
 * needs to stay comfortably inside the platform's budget (5 chunks × MAX_PAGES
 * = 25 outbound calls).
 */
export const SEATSAERO_MAX_CHUNKS = 5;

/**
 * Pages followed per chunk.
 *
 * Sized against the smaller page `include_trips` forces: 10 × 500 is the same
 * 5000 rows the old 5 × 1000 allowed, so the ceiling on what a chunk can see is
 * unchanged and only the number of calls to see it moved. A measured 90-day
 * single-pair chunk was 851 rows, so this is ~6x headroom — and multi-airport
 * spends that headroom, since one call now covers several city pairs.
 *
 * Hitting it is not a failure: the coverage claim gets narrowed to the last date
 * actually seen rather than over-stated, and the chunk says so in its notes.
 */
export const SEATSAERO_MAX_PAGES = 10;

/** seats.aero's cache runs roughly a year out, further than any single carrier's
 *  own booking horizon. */
export const SEATSAERO_HORIZON_DAYS = 365;

/** What a captured request header shows instead of the key. The capture is
 *  streamed to a browser and summarised into D1; the key must appear in neither. */
export const SEATSAERO_REDACTED = "<redacted>";

/** Default ceiling on how much response body one chunk will hold onto for
 *  display. A full page is up to 1000 rows (~600-900 KB); anything past this is
 *  reported as truncated rather than silently cut. */
export const SEATSAERO_MAX_CAPTURE_BYTES = 1_000_000;

/**
 * One HTTP call to seats.aero, recorded for display.
 *
 * This exists because "3 API calls" is a number you can't act on. When a search
 * comes back thinner than expected the question is always *which call, how long,
 * and what did it actually say*, and this is where that answer lives.
 *
 * Failed calls are recorded too, with whatever came back. A 500's body is often
 * the only explanation you get.
 *
 * The SPA reads this as `SearchCall`; it is the same type under the name the
 * screen that draws it uses.
 */
export interface SeatsAeroCall {
  /** 1-based page within the chunk. */
  index: number;
  method: string;
  url: string;
  /** With `Partner-Authorization` replaced by {@link SEATSAERO_REDACTED}. */
  requestHeaders: Record<string, string>;
  status?: number;
  ok: boolean;
  startedAt: number;
  durationMs: number;
  responseHeaders?: Record<string, string>;
  /** Decoded length of the response body. Equal to the byte count for the ASCII
   *  JSON seats.aero returns. */
  bytes: number;
  /** `data.length` — only known once the body parses. */
  rows?: number;
  /** The response body, up to the capture budget. Omitted when the budget is
   *  spent, which is a different thing from an empty body. */
  body?: string;
  bodyTruncated?: boolean;
  /** Set when the body was dropped entirely rather than truncated. */
  bodyOmitted?: boolean;
  error?: string;
}

export interface SeatsAeroChunk {
  start: string;
  end: string;
}
