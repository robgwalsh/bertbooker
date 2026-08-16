import type { AvailabilityResult, Cabin, Currency, Segment, SearchParams } from "../types.js";
import type { SourceCtx } from "../sources/types.js";
import { chunkDateRange, effectiveSearchWindow, todayISO } from "./window.js";
import { filterForParams } from "./filter.js";

// ---------------------------------------------------------------------------
// PointsYeah (https://www.pointsyeah.com) provider.
//
// PointsYeah's search backend is an anonymous JSON API (no auth/cookie needed,
// as confirmed by capturing a real request). We POST a search body and get back
// normalized award results including `transfer[]` — the list of card currencies
// that can book each result — which we map straight onto "bookable with my
// points". Program is an airline IATA code that maps to one of our loyalty
// programs.
//
// We hit the **search** endpoint (`/v2/live/explorer/search`), NOT the older
// `recommend` explorer. `recommend` only returns a sparse, curated handful of
// dates and ignores any date-range input, so a narrow tracked window usually
// matched none of them. `search` honors `start_date`/`end_date` — but with
// three server-side limits, discovered empirically, that shape our strategy:
//   1. A **rolling ~80-day horizon from *today***: any request whose start or
//      end lands beyond ~80 days out returns nothing. PointsYeah's live search
//      only materializes ~2.5 months of availability; there is no way to query
//      further out here (the far-future dates you see on their site come from a
//      separate curated cache, not this date-searchable endpoint). So we clamp
//      the tracked window to `[max(today, start), min(end, today+HORIZON_DAYS)]`
//      before searching — a year-long route still works, it just picks up dates
//      as they roll into the horizon on each periodic check.
//   2. A **~50-result cap** per request (pagination params are ignored). We
//      chunk the clamped window into small `CHUNK_DAYS` sub-windows so a dense
//      route stays under the cap, and log if a chunk ever hits it (truncation).
//   3. A **max span of ~80 days** per request — moot once we clamp+chunk, but
//      it's why one giant request can't replace the chunking.
//
// Primary transport is a plain fetch (cheap, works on the free tier IF the
// Worker's IP isn't bot-blocked). If direct fetch is blocked from Cloudflare
// IPs, the same request can be issued from Browser Rendering — see the
// `fetchImpl` seam and README notes.
// ---------------------------------------------------------------------------

const SEARCH_ENDPOINT = "https://api.pointsyeah.com/v2/live/explorer/search";

/** All card currencies PointsYeah knows — we request them all so `transfer[]`
 *  is complete, then derive `bookableWith` down to just the couple's currencies
 *  (Amex/Wells Fargo space still surfaces but resolves to "not bookable"). */
const SEARCH_BANKS = ["Chase", "Capital One", "Bilt", "Citi", "Amex", "Wells Fargo"];

/** Request every cabin; `filterForParams` narrows to the tracked cabin. */
const SEARCH_CABINS = ["Economy", "Premium Economy", "Business", "First"];

/** How far out (calendar days from today) PointsYeah's live search has data.
 *  The true cutoff is ~80 days; we stay under it so the last chunk never falls
 *  off the edge and returns nothing. */
export const POINTSYEAH_HORIZON_DAYS = 70;
const HORIZON_DAYS = POINTSYEAH_HORIZON_DAYS;

/** Stored in `availability_snapshots.source`. Permanent: migration 0009 renamed
 *  the rows written under the old `freetool:pointsyeah` id to this one. */
export const POINTSYEAH_SOURCE_ID = "pointsyeah";

/** Sub-window size (calendar days, inclusive). Small enough that per-call counts
 *  stay under the ~50-result cap for a dense route; a few of these tile the
 *  clamped horizon window. */
const CHUNK_DAYS = 20;

/** Hard ceiling on sub-windows per search, so a pathological window can't fan
 *  out unboundedly (HORIZON_DAYS/CHUNK_DAYS ≈ 4 in practice). */
const MAX_CHUNKS = 6;

/** Per-request result cap the endpoint enforces (pagination is ignored). A
 *  chunk returning this many may be truncated — we log it. */
const SEARCH_PAGE_CAP = 50;

/** Upper bound on per-result `detail_url` fetches per search, so a broad "any
 *  cabin" route can't fan out to hundreds of detail requests. Kept results
 *  beyond this keep their summary-level data (still shown, just no segment
 *  breakdown or booking link). */
const MAX_DETAIL_FETCHES = 60;

const REQUEST_HEADERS: Record<string, string> = {
  "content-type": "text/plain;charset=UTF-8",
  accept: "*/*",
  origin: "https://www.pointsyeah.com",
  referer: "https://www.pointsyeah.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

/** PointsYeah "program" (airline IATA) -> our programs.code. Only programs
 *  reachable from the couple's currencies are mapped; anything else is dropped
 *  (also protects the availability_snapshots.program foreign key). */
export const POINTSYEAH_PROGRAM_MAP: Record<string, string> = {
  AC: "aeroplan",
  AV: "lifemiles",
  TK: "turkish",
  UA: "united",
  SQ: "singapore",
  AF: "flyingblue",
  KL: "flyingblue",
  VS: "virginatlantic",
  BA: "avios",
  IB: "avios",
  EI: "avios",
  QR: "avios",
  AA: "aadvantage",
  AS: "alaska",
  CX: "cathay",
  QF: "qantas",
  EK: "emirates",
  EY: "etihad",
  BR: "eva",
  B6: "jetblue",
};

const CABIN_MAP: Record<string, Cabin> = {
  Economy: "economy",
  "Premium Economy": "premium",
  Business: "business",
  First: "first",
};

/** PointsYeah transfer.code -> our currency. Only the couple's currencies are
 *  listed, so Amex/Wells Fargo results resolve to "not bookable by us". */
const TRANSFER_MAP: Record<string, Currency> = {
  Chase: "chase_ur",
  "Capital One": "capital_one",
  Bilt: "bilt",
  Citi: "citi_ty",
};

export interface PointsYeahRoute {
  program: string;
  departure_date: string;
  departure: { code: string; city?: string; country_name?: string };
  arrival: { code: string; city?: string; country_name?: string };
  miles: number;
  tax: number;
  cabin: string;
  stops: number;
  seats: number;
  duration?: number;
  created_at?: number;
  updated_at?: number;
  transfer?: { bank?: string; code: string }[];
  /** Raw data URL for the itinerary (cloudfront JSON, not a bookable page). */
  detail_url?: string;
}

/** Response envelope. The `search` endpoint returns `{ total, results }`; the
 *  older `recommend` endpoint returned `{ code, success, data: { routes } }`.
 *  `normalizePointsYeah` reads either shape. */
export interface PointsYeahResponse {
  code?: number;
  success?: boolean;
  data?: { routes?: PointsYeahRoute[] };
  total?: number;
  results?: PointsYeahRoute[];
}

// Shape of the per-result `detail_url` feed (a static cloudfront JSON). It holds
// the full itinerary breakdown the list endpoint omits: real segments (flight
// numbers, times, aircraft) and a deep link to book on the airline's own site.
interface PointsYeahDetailSegment {
  departure_info?: { date_time?: string; airport?: { airport_code?: string } };
  arrival_info?: { date_time?: string; airport?: { airport_code?: string } };
  cabin?: string;
  flight?: { airline_code?: string; airline_name?: string; number?: string };
  aircraft?: string;
}
interface PointsYeahDetailRoute {
  segments?: PointsYeahDetailSegment[];
  duration?: number;
  /** Booking link on the operating/loyalty program's site (award search). */
  url?: string;
}
export interface PointsYeahDetail {
  routes?: PointsYeahDetailRoute[];
}

/** Extract the display-worthy itinerary detail from a `detail_url` payload. Uses
 *  the first offered routing (they share the same booking link). Pure. */
export function parseDetail(json: PointsYeahDetail): {
  segments: Segment[];
  bookingUrl?: string;
  durationMinutes?: number;
  stops?: number;
} {
  const route = json.routes?.[0];
  if (!route) return { segments: [] };
  const segments: Segment[] = (route.segments ?? []).map((s) => ({
    from: s.departure_info?.airport?.airport_code ?? "",
    to: s.arrival_info?.airport?.airport_code ?? "",
    carrier: s.flight?.airline_code ?? "",
    flightNumber: s.flight?.number,
    aircraft: s.aircraft || undefined,
    departsAt: s.departure_info?.date_time,
    arrivesAt: s.arrival_info?.date_time,
    cabin: s.cabin ? CABIN_MAP[s.cabin] : undefined,
  }));
  return {
    segments,
    bookingUrl: route.url || undefined,
    durationMinutes: typeof route.duration === "number" ? route.duration : undefined,
    stops: segments.length > 0 ? segments.length - 1 : undefined,
  };
}

/** Convert PointsYeah routes into normalized results. Rows with an unmapped
 *  program or cabin are dropped. Pure — no network — so it's unit-testable
 *  against a saved fixture. */
export function normalizePointsYeah(
  resp: PointsYeahResponse,
  source: string,
  fetchedAtFallback: number,
): AvailabilityResult[] {
  const routes = resp.data?.routes ?? resp.results ?? [];
  const out: AvailabilityResult[] = [];
  for (const r of routes) {
    const program = POINTSYEAH_PROGRAM_MAP[r.program];
    const cabin = CABIN_MAP[r.cabin];
    if (!program || !cabin) continue;

    const bookableWith = (r.transfer ?? [])
      .map((t) => TRANSFER_MAP[t.code])
      .filter((c): c is Currency => Boolean(c));

    out.push({
      origin: r.departure.code,
      destination: r.arrival.code,
      flightDate: r.departure_date,
      program,
      cabin,
      seatsAvailable: r.seats,
      milesCost: r.miles,
      cashFeesCents: Math.round((r.tax ?? 0) * 100),
      feesCurrency: "USD",
      isDirect: r.stops === 0,
      stops: r.stops,
      durationMinutes: r.duration,
      // Placeholder single segment; replaced with the real per-leg breakdown
      // (flight numbers, times, aircraft) once `detail_url` is fetched.
      segments: [{ from: r.departure.code, to: r.arrival.code, carrier: r.program, cabin }],
      source,
      sourceFetchedAt: r.updated_at ?? r.created_at ?? fetchedAtFallback,
      bookableWith,
    });
  }
  return out;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PointsYeahOptions {
  /** Override for tests / Browser-Rendering transport. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  endpoint?: string;
  bookableOnly?: boolean;
  /** Today's date (YYYY-MM-DD) for the request; defaults to now. Injectable so
   *  callers in a Date-less context (e.g. workflows) can supply it. */
  today?: string;
}

export class PointsYeahProvider {
  readonly id = POINTSYEAH_SOURCE_ID;
  readonly freshnessSeconds = 60 * 60 * 4;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly bookableOnly: boolean;
  private readonly today?: string;

  constructor(opts: PointsYeahOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.endpoint = opts.endpoint ?? SEARCH_ENDPOINT;
    this.bookableOnly = opts.bookableOnly ?? true;
    this.today = opts.today;
  }

  supports(p: SearchParams): boolean {
    return p.kind === "flight";
  }

  /** Sub-windows to fetch: the tracked window clamped to the live horizon, then
   *  tiled into cap-safe chunks. Empty when nothing is in-horizon. */
  private windowChunks(p: SearchParams, today: string): { start: string; end: string }[] {
    const win = effectiveSearchWindow(p.dateStart, p.dateEnd, today, HORIZON_DAYS);
    return win ? chunkDateRange(win.start, win.end, CHUNK_DAYS, MAX_CHUNKS) : [];
  }

  /** Fetch one date sub-window. Returns raw routes (may be empty). */
  private async fetchChunk(
    p: SearchParams,
    chunk: { start: string; end: string },
    today: string,
  ): Promise<PointsYeahRoute[]> {
    const body = JSON.stringify({
      banks: SEARCH_BANKS,
      cabins: SEARCH_CABINS,
      departure: { airport: p.origin },
      arrival: { airport: p.destination },
      seats: 1, // request broadly; minSeats is applied client-side
      start_date: chunk.start,
      end_date: chunk.end,
      today,
    });
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: REQUEST_HEADERS,
      body,
    });
    if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
    const json = (await res.json()) as PointsYeahResponse;
    return json.results ?? [];
  }

  async search(p: SearchParams, ctx: SourceCtx): Promise<AvailabilityResult[]> {
    const today = this.today ?? todayISO();
    const chunks = this.windowChunks(p, today);
    if (chunks.length === 0) {
      ctx.log(
        `pointsyeah ${p.origin}->${p.destination}: tracked window is entirely beyond the ~${HORIZON_DAYS}-day live horizon; nothing to search yet`,
        { provider: this.id },
      );
      return [];
    }

    // Fan the sub-windows out in parallel and merge. One failed chunk shouldn't
    // sink the whole search — but if *every* chunk fails, surface it so the
    // orchestrator logs a provider failure.
    const settled = await Promise.allSettled(
      chunks.map((ch) => this.fetchChunk(p, ch, today)),
    );
    const rawRoutes: PointsYeahRoute[] = [];
    let ok = 0;
    let firstError = "";
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        ok++;
        rawRoutes.push(...s.value);
        if (s.value.length >= SEARCH_PAGE_CAP) {
          ctx.log(
            `pointsyeah ${p.origin}->${p.destination} ${chunks[i]!.start}..${chunks[i]!.end}: hit ${SEARCH_PAGE_CAP}-result cap, may be truncated`,
            { provider: this.id },
          );
        }
      } else if (!firstError) {
        firstError = String(s.reason);
      }
    });
    if (ok === 0) {
      throw new Error(`${this.id}: all ${chunks.length} chunk fetch(es) failed: ${firstError || "unknown"}`);
    }

    // Normalize per raw route so each result keeps a handle on its detail_url.
    // (`filterForParams` returns the same object references, so a Set membership
    // test after filtering tells us which pairs survived.)
    const fetchedAt = Date.now();
    const pairs: { result: AvailabilityResult; detailUrl?: string }[] = [];
    for (const raw of rawRoutes) {
      const result = normalizePointsYeah({ results: [raw] }, this.id, fetchedAt)[0];
      if (result) pairs.push({ result, detailUrl: raw.detail_url });
    }
    const kept = new Set(
      filterForParams(pairs.map((pr) => pr.result), p, { bookableOnly: this.bookableOnly }),
    );
    const keptPairs = pairs.filter((pr) => kept.has(pr.result));
    // How much of the aggregator's answer our cabin/program/currency filters
    // threw away. A big gap here is usually the route's filters, not the source.
    ctx.log(`${this.id}: ${pairs.length} raw -> ${keptPairs.length} after filter`, {
      provider: this.id,
    });

    await this.enrichWithDetail(keptPairs, ctx);
    ctx.log(
      `pointsyeah ${p.origin}->${p.destination}: ${keptPairs.length} results across ${ok}/${chunks.length} chunk(s)`,
      { provider: this.id },
    );
    return keptPairs.map((pr) => pr.result);
  }

  /** Fetch each kept result's `detail_url` and fold in the real segment
   *  breakdown + booking link. Best-effort: a failed or capped fetch just leaves
   *  the summary-level result intact (still shown, no per-leg detail). */
  private async enrichWithDetail(
    pairs: { result: AvailabilityResult; detailUrl?: string }[],
    ctx: SourceCtx,
  ): Promise<void> {
    const withUrl = pairs.filter((pr) => pr.detailUrl);
    const targets = withUrl.slice(0, MAX_DETAIL_FETCHES);
    if (withUrl.length > targets.length) {
      ctx.log(
        `pointsyeah: detail enrichment capped at ${MAX_DETAIL_FETCHES}/${withUrl.length} results`,
        { provider: this.id },
      );
    }
    await Promise.all(
      targets.map(async (pr) => {
        try {
          const res = await this.fetchImpl(pr.detailUrl!, { method: "GET", headers: REQUEST_HEADERS });
          if (!res.ok) return;
          const detail = parseDetail((await res.json()) as PointsYeahDetail);
          if (detail.segments.length > 0) pr.result.segments = detail.segments;
          if (detail.bookingUrl) pr.result.bookingUrl = detail.bookingUrl;
          if (typeof detail.durationMinutes === "number") pr.result.durationMinutes = detail.durationMinutes;
          if (typeof detail.stops === "number") {
            pr.result.stops = detail.stops;
            pr.result.isDirect = detail.stops === 0;
          }
        } catch {
          // keep summary-level data
        }
      }),
    );
  }
}
