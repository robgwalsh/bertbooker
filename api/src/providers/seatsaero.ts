import type { AvailabilityResult, Cabin, Segment } from "../domain/types.js";
import type { SourceQuotaObservation } from "../domain/tasks.js";
import { currenciesForProgram } from "../domain/programs.js";
import { collapseBy, type Collapsible } from "../domain/collapse.js";
import { BlockedError, makeTransport, type FetchLike } from "./transport.js";
import { addDaysISO, chunkDateRange, effectiveSearchWindow } from "../domain/window.js";
// Re-exported at the bottom of this file as well; imported here because
// `export *` does not bind these names in local scope, and the loop below uses
// nearly all of them.
import {
  SEATSAERO_CHUNK_DAYS,
  SEATSAERO_HORIZON_DAYS,
  SEATSAERO_MAX_CAPTURE_BYTES,
  SEATSAERO_MAX_CHUNKS,
  SEATSAERO_MAX_PAGES,
  SEATSAERO_REDACTED,
  SEATSAERO_SOURCE_ID,
  type SeatsAeroCall,
  type SeatsAeroChunk,
} from "../../../shared/src/wire/seatsaero.js";

// ---------------------------------------------------------------------------
// seats.aero Partner API.
//
//
// Everything here is environment-neutral on purpose — `fetch`, `Headers`,
// `URLSearchParams` and nothing else — because it has to run on workerd.
//
// This is the only *authenticated, metered* source in the repo: a Pro key buys
// 1000 calls per calendar day, resetting at 00:00 UTC, and every response
// carries the remaining count in a header (see `parseQuotaHeaders`).
//
// We use **Cached Search only** (`GET /partnerapi/search`). It is by far the
// best value the API offers: one call returns a page of availability rows
// spanning ~20 mileage programs, a whole date range and several airports, so a
// year-long sweep costs a handful of calls. `POST /live` is a real-time query
// against the airline, but costs one call per (route, date, program) and takes
// 5-15s, which would spend the day on one route's one week.
//
// **`include_trips=true` is sent** (measured 2026-08-10), so the routing —
// connection airports, flight numbers, aircraft, fare classes, total duration —
// arrives with the search for no extra metered call. `minify_trips` is never
// sent: it halves the bytes by dropping exactly those fields.
//
// What an embedded trip does NOT carry is **per-leg times** — it has no
// `AvailabilitySegments`, only the whole journey's endpoints — so a layover
// inside it is unmeasured, and a cabin no trip described stays a `summary`.
// `GET /trips/{id}` is the fallback for both, at ONE CALL PER availability
// object, which is why it is a click (`api/src/search/enrich.ts`) and never
// part of a search. The remaining limitation is recorded on the task's notes
// rather than hidden — see `runSeatsAeroChunk` below.
//
// The other thing to internalise: these rows come out of seats.aero's **cache**,
// not off the airline. `UpdatedAt` is therefore load-bearing — it becomes
// `sourceFetchedAt`, and it is what a reader compares by freshest
// `source_fetched_at`, so a week-old cached row can never out-rank a fresh
// row from another source. Never substitute the fetch time for it.
// ---------------------------------------------------------------------------

export const SEATSAERO_BASE = "https://seats.aero/partnerapi";

/** Rows per page. The documented maximum; fewer pages means fewer API calls,
 *  which is the whole game here. */
export const SEATSAERO_TAKE = 1000;

/**
 * Rows per page when `include_trips` is on, and the reason it is lower.
 *
 * Measured 2026-08-10 (`npm run probe:seatsaero-search`, recorded in
 * docs/SEATS-AERO.md): a summary row is ~2.2 KB, the same row with its trips is
 * ~9.9 KB. At `take=1000` that is a **10 MB response**, which the Worker
 * would have to hold as text and again as parsed objects. 500 keeps a page near
 * 5 MB.
 *
 * The cost of the smaller page is pages, and pages are calls: the SFO->NRT
 * 90-day chunk that fitted in one call now takes two. That is the trade the whole
 * feature turns on, and it is overwhelmingly worth it — the alternative way to
 * learn the same routing is `/trips/{id}` at **one call per row**, so 851 rows
 * would be 851 calls against these two.
 */
export const SEATSAERO_TAKE_WITH_TRIPS = 500;

/**
 * seats.aero `Source` string -> our `programs.code`.
 *
 * Only programs that exist in `PROGRAM_SEEDS` appear here, because
 * `finds.program` is a foreign key — an unmapped source would
 * fail the insert rather than merely be uninteresting. Everything else is
 * dropped and counted (`normalizeSeatsAero` reports `droppedSources`), so a
 * program we could be storing and aren't shows up as a number rather than as
 * silence.
 *
 * **Every key here was verified live on 2026-08-09** against
 * `GET /partnerapi/routes?source=<name>` (documented at
 * developers.seats.aero/reference/get-routes-1, and since 2026-08-18 the
 * Library's seats.aero pane runs the same check as a surface rather than as a
 * terminal ritual), and that verification is not optional
 * ceremony: **the API silently ignores an unrecognised `sources` value.** It
 * answers `200 {"data":[]}` rather than erroring, so a misspelled name is not a
 * bug you find — it is a program that quietly contributes nothing forever. Four
 * plausible-looking guesses (`britishairways`, `ana`, `cathay`, `eva`) failed
 * exactly that way before being checked.
 *
 * Deliberately absent, because seats.aero has no such source under any spelling
 * tried: **ANA, Cathay, EVA, Aer Lingus.** Those programs stay in
 * `PROGRAM_SEEDS` — they are simply not obtainable from here.
 *
 * Eight real sources we knowingly don't map, because each would need a new entry
 * in BOTH `data/programs.ts` and `seed/programs.sql` and none of them is
 * reachable from a currency the couple holds: `SEATSAERO_UNMAPPED_SOURCES`.
 * (`connectmiles` is NOT one of them — it returns zero routes, same as the four
 * names above, and sits in `SEATSAERO_ZERO_ROUTE_NAMES`. Copa's source is
 * `copa`; `connectmiles` is only the program's *name*, which is exactly the
 * trap `britishairways` fell into.)
 */
export const SEATSAERO_PROGRAM_MAP: Record<string, string> = {
  aeromexico: "aeromexico",
  aeroplan: "aeroplan",
  alaska: "alaska",
  american: "aadvantage",
  delta: "skymiles",
  emirates: "emirates",
  etihad: "etihad",
  flyingblue: "flyingblue",
  jetblue: "jetblue",
  lifemiles: "lifemiles",
  qantas: "qantas",
  singapore: "singapore",
  turkish: "turkish",
  united: "united",
  virginatlantic: "virginatlantic",
  // The Avios family — three programs seats.aero carries, one currency pool,
  // one programs.code. Note `british`, NOT `britishairways`.
  qatar: "avios",
  british: "avios",
  iberia: "avios",
};

/** The `sources` query param: ask for exactly the programs we can store, so the
 *  response contains nothing we would have to drop and the coverage claim
 *  matches what we asked about. */
export const SEATSAERO_SOURCES: string[] = Object.keys(SEATSAERO_PROGRAM_MAP);

/** Distinct `programs.code` values this source can emit. */
export const SEATSAERO_PROGRAMS: string[] = [...new Set(Object.values(SEATSAERO_PROGRAM_MAP))];

/** seats.aero cabin letter -> our cabin. Y/W/J/F is the whole vocabulary. */
const CABIN_LETTERS: readonly { letter: "Y" | "W" | "J" | "F"; cabin: Cabin }[] = [
  { letter: "Y", cabin: "economy" },
  { letter: "W", cabin: "premium" },
  { letter: "J", cabin: "business" },
  { letter: "F", cabin: "first" },
];

// --- wire types ------------------------------------------------------------

export interface SeatsAeroRoute {
  ID?: string;
  OriginAirport?: string;
  DestinationAirport?: string;
  OriginRegion?: string;
  DestinationRegion?: string;
  Distance?: number;
  Source?: string;
}

/**
 * One availability summary: a (route, date, program) triple with a per-cabin
 * rollup. The per-cabin fields are flat and letter-prefixed rather than nested,
 * hence the index signature — `a[`${letter}Available`]` is how they're read.
 */
export interface SeatsAeroAvailability {
  ID?: string;
  RouteID?: string;
  Route?: SeatsAeroRoute;
  /** Departure date. Usually YYYY-MM-DD; `ParsedDate` may carry a full ISO ts. */
  Date?: string;
  ParsedDate?: string;
  Source?: string;
  CreatedAt?: string | number;
  UpdatedAt?: string | number;
  TaxesCurrency?: string;
  [key: string]: unknown;
}

export interface SeatsAeroSearchResponse {
  data?: SeatsAeroAvailability[];
  count?: number;
  hasMore?: boolean;
  cursor?: number | string;
}

// --- request ---------------------------------------------------------------

export interface SeatsAeroSearchQuery {
  /** One or more airports per side. Joined with commas here so no caller can
   *  invent a second convention — verified live 2026-08-10: `SFO,OAK,SJC` ->
   *  `NRT,HND` answers with rows for every pair it has, interleaved by date. */
  origin: string | string[];
  destination: string | string[];
  startDate: string;
  endDate: string;
  cursor?: number | string;
  take?: number;
  sources?: string[];
  /** Ask for the itinerary behind each summary row, at no extra call. Changes
   *  the default `take` — see `SEATSAERO_TAKE_WITH_TRIPS`. */
  includeTrips?: boolean;
}

/** How many rows a page should hold given whether trips ride along. */
export function seatsAeroTake(includeTrips: boolean | undefined): number {
  return includeTrips ? SEATSAERO_TAKE_WITH_TRIPS : SEATSAERO_TAKE;
}

const airportList = (v: string | string[]): string =>
  (Array.isArray(v) ? v : [v]).map((s) => s.trim().toUpperCase()).filter(Boolean).join(",");

/**
 * Build a Cached Search URL. Pure.
 *
 * `order_by` is deliberately left at its default (departure date). That is not
 * cosmetic: it is what makes the truncation rule in the runner below sound —
 * if we stop paginating early, the dates we lost are the *far* ones, so the
 * coverage claim can be narrowed to "everything up to the last date we saw".
 * Sorting by lowest mileage instead would scatter the missing dates through the
 * window and make any narrowing a guess.
 *
 * That reasoning now has to hold across SEVERAL airport pairs in one call, and it
 * does: the probe confirmed the response is ordered by date *globally*, with the
 * pairs interleaved rather than emitted as per-pair blocks. So a truncated read
 * still loses the far end of the window for every pair at once. Were it ever
 * grouped by pair, a single global `maxDate` would over-claim on the pairs the
 * cursor never reached and hard-delete their finds — see the ledger.
 *
 * `only_direct_flights` and `cabins` are documented and deliberately never sent:
 * gather wide, query narrow. Anything filtered out here is missing from the
 * database for every future question, including ones nobody has asked yet.
 */
export function buildSearchUrl(q: SeatsAeroSearchQuery): string {
  const params = new URLSearchParams({
    origin_airport: airportList(q.origin),
    destination_airport: airportList(q.destination),
    start_date: q.startDate,
    end_date: q.endDate,
    take: String(q.take ?? seatsAeroTake(q.includeTrips)),
    sources: (q.sources ?? SEATSAERO_SOURCES).join(","),
  });
  // `minify_trips` is NOT set with it, and that is deliberate: it halves the
  // bytes by dropping Connections, FlightNumbers, Aircraft and FareClasses —
  // exactly the fields the routing is made of. It leaves a payload that says a
  // connection exists without saying where.
  if (q.includeTrips) params.set("include_trips", "true");
  if (q.cursor != null) params.set("cursor", String(q.cursor));
  return `${SEATSAERO_BASE}/search?${params.toString()}`;
}

// --- quota -----------------------------------------------------------------

/**
 * Read the remaining daily allowance off a response. Pure.
 *
 * Returns `undefined` — never a fabricated number — when the header is absent
 * or unparseable. A missing observation shows as "not seen yet" in the UI,
 * which is honest; a guessed 1000 would read as "plenty left" on the exact day
 * you'd want to know otherwise.
 */
export function parseQuotaHeaders(
  headers: Headers,
  source: string,
  observedAt: number,
): SourceQuotaObservation | undefined {
  // Explicit null check first: `Number(null)` is 0, so falling straight into
  // the numeric parse would turn a MISSING header into "0 calls left today" —
  // an exhausted quota that never happened, which is the one wrong answer this
  // function must never give.
  const rawRemaining = headers.get("x-ratelimit-remaining");
  if (rawRemaining == null || rawRemaining.trim() === "") return undefined;
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(remaining) || remaining < 0) return undefined;

  const rawLimit = headers.get("x-ratelimit-limit");
  const parsedLimit = rawLimit == null ? NaN : Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
  return { source, remaining, limit, observedAt };
}

// --- normalize -------------------------------------------------------------

export interface NormalizeResult {
  offers: AvailabilityResult[];
  /** seats.aero `Source` values we had no `programs.code` for, with counts.
   *  Surfaced as a task note so unmapped breadth is visible, not silent. */
  droppedSources: Record<string, number>;
  /** Max `flightDate` actually seen. The runner narrows its coverage
   *  claim to this when pagination was truncated. */
  maxDate?: string;
}

/**
 * Cached Search payload -> normalized results. Pure, and the whole of what the
 * unit tests assert on.
 *
 * One availability object fans out to up to FOUR results — one per cabin with
 * space. The snapshot row is keyed (route, date, program, cabin), so this is a
 * fan-out into distinct rows rather than a collapse problem; there is no
 * collapse step because seats.aero has already collapsed the itineraries
 * for us (which is also why there are no real segments).
 */
export function normalizeSeatsAero(
  resp: SeatsAeroSearchResponse,
  sourceId: string,
  fetchedAtFallback: number,
): NormalizeResult {
  const offers: AvailabilityResult[] = [];
  const droppedSources: Record<string, number> = {};
  let maxDate: string | undefined;

  for (const a of resp.data ?? []) {
    const rawSource = String(a.Source ?? a.Route?.Source ?? "");
    const program = SEATSAERO_PROGRAM_MAP[rawSource];
    if (!program) {
      if (rawSource) droppedSources[rawSource] = (droppedSources[rawSource] ?? 0) + 1;
      continue;
    }

    const flightDate = isoDate(a.Date ?? a.ParsedDate);
    if (!flightDate) continue;

    // Off the payload's own Route, never off the request: seats.aero answers a
    // multi-airport query with rows for whichever airports it has, and the
    // ingest pipeline keys coverage and pruning on the route it is told.
    const origin = String(a.Route?.OriginAirport ?? "").toUpperCase();
    const destination = String(a.Route?.DestinationAirport ?? "").toUpperCase();
    if (!origin || !destination) continue;

    if (!maxDate || flightDate > maxDate) maxDate = flightDate;

    // `bookableWith` comes from our own transfer-partner table, not the payload:
    // seats.aero carries no transfer data at all. An empty array is a correct
    // answer for a program nothing transfers to, and the row is still stored —
    // it just cannot surface under a currency-filtered route.
    const bookableWith = currenciesForProgram(program);
    const sourceFetchedAt = epochMs(a.UpdatedAt) ?? epochMs(a.CreatedAt) ?? fetchedAtFallback;
    const feesCurrency = String(a.TaxesCurrency ?? "USD") || "USD";
    // The handle `GET /trips/{id}` takes. One id per (route, date, program), so
    // every cabin below shares it and one detail call expands all of them.
    const sourceRecordId = String(a.ID ?? "") || undefined;

    // --- the itinerary, when `include_trips` asked for it ---------------------
    // One pre-pass over the embedded trips for the whole availability row,
    // because the price filter needs every cabin's price at once and the trips
    // are shared across all four. Costs no extra call: these rode along on the
    // search response.
    const embedded = Array.isArray(a.AvailabilityTrips) ? (a.AvailabilityTrips as SeatsAeroTrip[]) : [];
    const detailByCabin = new Map<Cabin, SeatsAeroTripDetail>();
    if (embedded.length) {
      const wanted = new Map<Cabin, number>();
      for (const { letter, cabin } of CABIN_LETTERS) {
        if (!truthy(a[`${letter}Available`])) continue;
        const m = num(a[`${letter}MileageCost`]);
        if (m > 0) wanted.set(cabin, m);
      }
      if (wanted.size) {
        for (const d of collapseTripsByCabin(embedded, wanted).details) {
          detailByCabin.set(d.cabin, d);
        }
      }
    }

    for (const { letter, cabin } of CABIN_LETTERS) {
      if (!truthy(a[`${letter}Available`])) continue;
      const milesCost = num(a[`${letter}MileageCost`]);
      if (!milesCost || milesCost <= 0) continue;

      const airlines = splitAirlines(a[`${letter}Airlines`]);
      const directAirlines = splitAirlines(a[`${letter}DirectAirlines`]);
      // Whether a nonstop exists AT ALL in this cabin — not whether the award
      // quoted below is one. They differ whenever `{L}DirectMileageCost` is
      // dearer than `{L}MileageCost`, which is common.
      const nonstopExists = truthy(a[`${letter}Direct`]);
      const directMilesCost = num(a[`${letter}DirectMileageCost`]) || undefined;
      const detail = detailByCabin.get(cabin);

      // `{L}Airlines` is every carrier appearing on ANY itinerary in this cabin;
      // `{L}DirectAirlines` is the subset that flies it nonstop. The captured
      // SFO->NRT row reads `YAirlines: "AS, CX, JL, JX, PR"` beside
      // `YDirectAirlines: "JL"` — so taking `airlines[0]` for a nonstop row
      // named AS, the one carrier that specifically does NOT fly it nonstop.
      const summaryCarrier = (nonstopExists ? directAirlines[0] : undefined) ?? airlines[0] ?? "";
      const segments: Segment[] = detail
        ? detail.segments
        : [{ from: origin, to: destination, carrier: summaryCarrier, cabin }];
      // With a real itinerary in hand, directness is a fact about THIS award
      // rather than about the cabin. Without one, the row's flag is all there is.
      const isDirect = detail ? detail.stops === 0 : nonstopExists;

      offers.push({
        origin,
        destination,
        flightDate,
        program,
        cabin,
        // 0 means "this program doesn't report seat counts" (AA, Emirates), not
        // "no seats" — `Available` already told us there is at least one. Storing
        // the literal 0 would make every such row invisible to any minSeats
        // filter, which is the opposite of what the payload says.
        seatsAvailable: Math.max(1, num(a[`${letter}RemainingSeats`])),
        milesCost,
        cashFeesCents: Math.round(num(a[`${letter}TotalTaxes`])),
        feesCurrency,
        isDirect,
        segments,
        // `undefined` means UNKNOWN, and it stays that way for a summary row:
        // Cached Search without trips never says how many stops a connecting
        // award has. It is stored in the nullable `stop_count` column, whose
        // NULL is exactly this "unknown".
        stops: detail ? detail.stops : nonstopExists ? 0 : undefined,
        durationMinutes: detail?.durationMinutes,
        bookingUrl: detail?.bookingUrl,
        // Kept rather than discarded: which carriers serve this cabin, which of
        // them fly it nonstop, and what the nonstop costs when it is dearer than
        // the award quoted here. All three are on the wire already.
        airlines,
        directAirlines,
        directMilesCost: nonstopExists ? directMilesCost : undefined,
        sourceRecordId,
        // A row is a summary only when no trip described it. With
        // `include_trips` that is now the exception — the search itself carries
        // the legs, and `/trips/{id}` is the fallback for what it leaves out
        // (per-leg times) rather than the only way to learn anything.
        detailLevel: detail ? "itinerary" : "summary",
        sourceFetchedAt,
        bookableWith,
      });
    }
  }

  return { offers, droppedSources, maxDate };
}

// --- planning and running a search -----------------------------------------
//
// The economics are the design. A Pro key buys 1000 calls per UTC day; one
// Cached Search call returns up to 1000 rows across ~20 programs and a whole date
// range. So we plan by *date chunk*, not by date: a full-horizon window is five
// chunks and roughly five to ten calls, versus the ~365 a per-date source would
// spend.
//
// This loop is why `seatsAeroSource` (src/sources/seatsaero.ts) is a
// DESCRIPTOR and not a `RunnableSource`: two things here have no counterpart in
// the generic contract. It hands back a **quota observation** read off a
// response header, and it can **narrow its own coverage claim** when pagination
// is cut short — and it is resumable mid-window, which is what lets a 30-second
// cron tick pick up where the last one stopped. The Worker drives it directly
// (`api/src/search/run.ts`); see docs/SOURCES.md.

// The constants and the two call/chunk shapes above this line now live in
// `../wire/seatsaero.ts`, because the SPA reads them and this file cannot be on
// an app import path — it is 1436 lines and speaks `fetch`. Re-exported here so
// this module's public surface, and therefore the root barrel's, is unchanged:
// every existing `api/` import still resolves against this file.
export * from "../../../shared/src/wire/seatsaero.js";

/** The durable half of a call record: everything except the body. This is what
 *  is streamed to whoever is watching, matching the shape the call inspector is
 *  documented to hold ("intercepted responses: url, status, bytes"). Bodies are
 *  session-only — they live in the stream and in the tab that asked. */
export function callMetadata(c: SeatsAeroCall): Omit<SeatsAeroCall, "body"> {
  const { body: _body, ...rest } = c;
  return rest;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Split a tracked route's window into request-sized chunks, clamped to the live
 * horizon. Pure. Returns `[]` when the window lies entirely in the past or
 * entirely beyond the horizon — which the caller must treat as "nothing to
 * search", not as "searched and found nothing".
 */
export function planSeatsAeroChunks(
  dateStart: string,
  dateEnd: string,
  today: string,
): SeatsAeroChunk[] {
  const win = effectiveSearchWindow(dateStart, dateEnd, today, SEATSAERO_HORIZON_DAYS);
  if (!win) return [];
  return chunkDateRange(win.start, win.end, SEATSAERO_CHUNK_DAYS, SEATSAERO_MAX_CHUNKS);
}

/**
 * The task key for a chunk. Derived from the work, so a re-run is idempotent
 * across two plans of the same route.
 *
 * A key describes ONE CALL, and one call may cover many city pairs, so the
 * airports are joined with `+` and never with `,`. That is deliberate: a comma
 * here would make the key indistinguishable from the `origin-destination` form
 * of a single-pair task, and anything that later tried to read a pair back out
 * of a key would silently succeed with the wrong answer. Nothing should parse
 * this — but a key gets eyeballed in a log line, and one that cannot be
 * misread is worth the character.
 *
 * The lists arrive sorted from `normalizeAirports`, which is what makes the key
 * stable across two plans over the same set.
 */
export function seatsAeroTaskKey(
  origins: string | string[],
  destinations: string | string[],
  c: SeatsAeroChunk,
  role?: string,
): string {
  const join = (v: string | string[]) => (Array.isArray(v) ? v : [v]).join("+");
  const prefix = role && role !== "direct" ? `seatsaero:${role}` : "seatsaero";
  return `${prefix}:${join(origins)}-${join(destinations)}:${c.start}..${c.end}`;
}

/** Inclusive ISO span → discrete dates, with a guard so a pathological span
 *  can't fan out. */
export function datesIn(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysISO(d, 1)) {
    out.push(d);
    if (out.length > 400) break;
  }
  return out;
}

export interface SeatsAeroChunkOptions {
  /** One or more airports per side; one call covers the whole cross product. */
  origin: string | string[];
  destination: string | string[];
  apiKey: string;
  /** Ask each row to carry its itinerary. Defaults to ON: it costs no extra
   *  call, and the only other way to learn the same routing is `/trips/{id}` at
   *  one call PER ROW. Pass `false` for a deliberately cheap availability-only
   *  sweep. */
  includeTrips?: boolean;
  /** Reuse ONE transport across a whole search: "the key was refused" is a fact
   *  about the source, not about one chunk, and `makeTransport` is sticky so the
   *  remaining chunks stop asking. Omitted = a fresh one for this chunk. */
  transport?: FetchLike;
  signal?: AbortSignal;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Fallback for `sourceFetchedAt` when a row carries no timestamp of its own,
   *  and the stamp on the quota observation. Injectable for tests. */
  now?: () => number;
  /** Called as each HTTP call finishes, successful or not, so a caller streaming
   *  progress can show it immediately instead of after the whole chunk. Awaited,
   *  so a slow consumer applies backpressure rather than piling up. */
  onCall?: (call: SeatsAeroCall) => void | Promise<void>;
  /** Response-body bytes this chunk may hold onto across all its pages. Past it,
   *  calls are still recorded — with `bodyOmitted` — because knowing a call
   *  happened matters more than reading it. Defaults to
   *  {@link SEATSAERO_MAX_CAPTURE_BYTES}; pass 0 to record metadata only. */
  maxCaptureBytes?: number;
}

export interface SeatsAeroChunkResult {
  offers: AvailabilityResult[];
  /** What this chunk is entitled to claim it checked. Narrower than the chunk's
   *  own dates when pagination truncated. */
  coveredDates: string[];
  finalUrl?: string;
  httpStatus?: number;
  notes: string[];
  quota?: SourceQuotaObservation;
  /** Outbound calls actually spent — i.e. successful pages, the number that
   *  matters against the daily allowance. Failed attempts are in `calls`. */
  pages: number;
  truncated: boolean;
  /** Every HTTP call attempted, in order, including the one that threw. */
  calls: SeatsAeroCall[];
  /** Response bytes actually held onto, so a caller running a budget across
   *  several chunks can subtract it. */
  capturedBytes: number;
}

/** Build the request headers. The docs say only "your key in this header"; if a
 *  live call ever 401s, `Bearer ${apiKey}` is the first thing to try — but a 401
 *  already classifies as blocked, so it reports itself loudly. */
export function seatsAeroHeaders(apiKey: string): Record<string, string> {
  return { "Partner-Authorization": apiKey, accept: "application/json" };
}

/**
 * Run one date chunk: page through Cached Search, normalize, and report what it
 * is allowed to claim.
 *
 * **Throwing is the failure protocol.** Never catch in here and return an empty
 * result: `offers: []` with a coverage claim means "I looked and there is
 * nothing", which licenses a prune. 401/403/429 and challenge pages never reach
 * the caller as data — `makeTransport` turns them into `BlockedError`.
 */
export async function runSeatsAeroChunk(
  chunk: SeatsAeroChunk,
  opts: SeatsAeroChunkOptions,
): Promise<SeatsAeroChunkResult> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.transport ?? makeTransport({ log });
  const headers = seatsAeroHeaders(opts.apiKey);
  const chunkDates = datesIn(chunk.start, chunk.end);

  const offers: AvailabilityResult[] = [];
  const dropped: Record<string, number> = {};
  const notes: string[] = [];
  const calls: SeatsAeroCall[] = [];
  let quota: SourceQuotaObservation | undefined;
  let httpStatus: number | undefined;
  let finalUrl: string | undefined;
  let maxDate: string | undefined;
  let truncated = false;
  let cursor: number | string | undefined;
  let pages = 0;

  // The key must never reach a capture: these records are streamed to a browser
  // and summarised into D1.
  const capturedRequestHeaders = { ...headers, "Partner-Authorization": SEATSAERO_REDACTED };
  let captureLeft = opts.maxCaptureBytes ?? SEATSAERO_MAX_CAPTURE_BYTES;
  let capturedBytes = 0;
  const includeTrips = opts.includeTrips ?? true;

  /** Record one call, spending the body budget, and hand it to `onCall`. */
  const record = async (c: Omit<SeatsAeroCall, "body" | "bodyTruncated" | "bodyOmitted">, text?: string) => {
    const call: SeatsAeroCall = { ...c };
    if (text != null) {
      if (captureLeft <= 0) {
        call.bodyOmitted = true;
      } else if (text.length > captureLeft) {
        call.body = text.slice(0, captureLeft);
        call.bodyTruncated = true;
        capturedBytes += captureLeft;
        captureLeft = 0;
      } else {
        call.body = text;
        capturedBytes += text.length;
        captureLeft -= text.length;
      }
    }
    calls.push(call);
    await opts.onCall?.(call);
    return call;
  };

  for (;;) {
    const url = buildSearchUrl({
      origin: opts.origin,
      destination: opts.destination,
      startDate: chunk.start,
      endDate: chunk.end,
      includeTrips,
      take: seatsAeroTake(includeTrips),
      cursor,
    });
    finalUrl = url;

    const index = calls.length + 1;
    const startedAt = now();
    const base = { index, method: "GET", url, requestHeaders: capturedRequestHeaders, startedAt };

    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers, signal: opts.signal });
    } catch (err) {
      // Records the refusal itself, including the sticky "we already know the key
      // is bad" case where no request left the machine. Then rethrows, because
      // throwing is the failure protocol and a recorded call is not an answer.
      //
      // `BlockedError` carries the status it was refused with, and that number is
      // the single most useful thing here — 401 (wrong key) and 429 (out of
      // allowance) call for completely different fixes. A sticky refusal reports
      // status 0, which is honest: nothing was asked.
      const status = err instanceof BlockedError && err.status > 0 ? err.status : undefined;
      await record({
        ...base,
        status,
        ok: false,
        durationMs: now() - startedAt,
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    httpStatus = res.status;
    const text = await res.text();
    const common = {
      ...base,
      status: res.status,
      durationMs: now() - startedAt,
      responseHeaders: headersToObject(res.headers),
      bytes: text.length,
    };

    if (!res.ok) {
      // Capture the body anyway — a 4xx/5xx explanation is usually only in there.
      await record({ ...common, ok: false }, text);
      throw new Error(`${SEATSAERO_SOURCE_ID}: HTTP ${res.status}`);
    }

    // Read the allowance off EVERY response; the last one is the truest.
    quota = parseQuotaHeaders(res.headers, SEATSAERO_SOURCE_ID, now()) ?? quota;

    let body: SeatsAeroSearchResponse;
    try {
      body = JSON.parse(text) as SeatsAeroSearchResponse;
    } catch (err) {
      await record(
        { ...common, ok: false, error: `unparseable JSON: ${String(err)}` },
        text,
      );
      throw err;
    }
    await record({ ...common, ok: true, rows: body.data?.length ?? 0 }, text);

    const norm = normalizeSeatsAero(body, SEATSAERO_SOURCE_ID, now());
    offers.push(...norm.offers);
    for (const [src, n] of Object.entries(norm.droppedSources)) {
      dropped[src] = (dropped[src] ?? 0) + n;
    }
    if (norm.maxDate && (!maxDate || norm.maxDate > maxDate)) maxDate = norm.maxDate;

    pages++;
    if (!body.hasMore || body.cursor == null) break;
    if (pages >= SEATSAERO_MAX_PAGES) {
      truncated = true;
      break;
    }
    cursor = body.cursor;
  }

  // Read the claim off the payload, never off the plan. Results come back ordered
  // by departure date (`buildSearchUrl` leaves `order_by` at its default
  // precisely so this holds), so a truncated read loses the FAR end of the window
  // and only the far end — claiming the whole chunk anyway would let a later
  // prune delete real finds on dates we never actually saw.
  let coveredDates = chunkDates;
  if (truncated) {
    coveredDates = maxDate ? chunkDates.filter((d) => d <= maxDate!) : [];
    notes.push(
      `paginated out at ${SEATSAERO_MAX_PAGES} pages with more remaining — coverage narrowed to ${
        coveredDates.length
      }/${chunkDates.length} dates (through ${maxDate ?? "none"})`,
    );
  }

  if (quota) {
    log(
      `${SEATSAERO_SOURCE_ID}: ${quota.remaining}${
        quota.limit ? `/${quota.limit}` : ""
      } API calls left today`,
      { remaining: quota.remaining, limit: quota.limit, callsThisChunk: pages },
    );
  } else {
    notes.push("no x-ratelimit-remaining header on any response");
  }

  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
  if (droppedTotal) {
    notes.push(
      `dropped ${droppedTotal} rows from unmapped programs: ${Object.entries(dropped)
        .map(([s, n]) => `${s}×${n}`)
        .join(", ")}`,
    );
  }

  // Recorded, not buried. `include_trips` puts the routing on the search
  // response for free, but it is not guaranteed per row — so say how many rows
  // actually came back described rather than asserting either state.
  if (includeTrips) {
    const summaries = offers.filter((o) => o.detailLevel === "summary").length;
    notes.push(
      summaries === 0
        ? "itineraries included — flight numbers and routing, but no per-leg times (those need Get Trips)"
        : `${offers.length - summaries}/${offers.length} rows carry an itinerary; ${summaries} stayed summaries (enrichable per row via Get Trips)`,
    );
  } else {
    notes.push("cached summary — no flight numbers or segments (enrichable per row via Get Trips)");
  }

  return {
    offers,
    coveredDates,
    finalUrl,
    httpStatus,
    notes,
    quota,
    pages,
    truncated,
    calls,
    capturedBytes,
  };
}

// ---------------------------------------------------------------------------
// Get Trips — the per-itinerary detail behind a summary row.
//
// `GET /partnerapi/trips/{availabilityId}` costs ONE CALL PER AVAILABILITY ROW,
// which is why it plays no part in a search: a 200-row chunk would spend a fifth
// of the day's allowance on decoration. It is affordable exactly once the choice
// is a person's — one click, one row, one call — so this half is driven by
// `api/src/search/enrich.ts` and never by the search path.
//
// One availability id covers ALL FOUR CABINS of a (route, date, program), so a
// single call expands up to four `finds` rows. That is the
// entire economics of the feature and the reason the id, not the find, is the
// unit of work.
//
// Captured live 2026-08-10 (`npm run probe:seatsaero-trips`); the fixture beside
// this file is that capture, untrimmed. Four things it settled that the docs do
// not say, each of which would have been a plausible wrong guess:
//
//   1. **A trip's `MileageCost` is a NUMBER**, unlike Cached Search's string.
//   2. **`Cabin` is a full word** ("economy", "business"), not the Y/W/J/F letter
//      the search rows use.
//   3. **The trips are NOT all the same award.** One SFO->NRT economy row
//      expanded into trips at 37,500 / 40,000 / 75,000 miles. The summary quotes
//      the cheapest, so anything dearer is a DIFFERENT find that happens to
//      share an id — see `parseSeatsAeroTrips`.
//   4. **`DepartsAt`/`ArrivesAt` are local times wearing a `Z`.** `AS515`
//      SEA->NRT reads `11:50:00Z` -> `15:05:00Z` next day, which is 27h elapsed
//      against a stated `Duration` of 615 minutes. They are local; the suffix is
//      a lie, and storing it would claim UTC for a wall-clock time.
// ---------------------------------------------------------------------------

/** One flown leg of a trip. `Order` is authoritative — do not trust array order. */
export interface SeatsAeroTripSegment {
  FlightNumber?: string;
  AircraftName?: string;
  AircraftCode?: string;
  OriginAirport?: string;
  DestinationAirport?: string;
  DepartsAt?: string;
  ArrivesAt?: string;
  Cabin?: string;
  Order?: number;
  [key: string]: unknown;
}

/**
 * One bookable itinerary under an availability row.
 *
 * The same object arrives two ways, and they are NOT identical:
 *
 *  - `GET /trips/{id}` — carries `AvailabilitySegments`, the per-leg array with
 *    each leg's own times, distance and fare class.
 *  - `GET /search?include_trips=true` — carries **no segment array at all**.
 *    Instead the routing is spread across `OriginAirport` + `Connections` +
 *    `DestinationAirport` and the parallel `FlightNumbers` / `Aircraft` /
 *    `FareClasses` lists, with only trip-level `DepartsAt` / `ArrivesAt`.
 *
 * So the search form knows *which aeroplanes and via where*, and the trips form
 * additionally knows *when each leg goes*. `tripSegments` reads whichever is
 * present, which is why one type covers both.
 */
export interface SeatsAeroTrip {
  ID?: string;
  AvailabilityID?: string;
  AvailabilitySegments?: SeatsAeroTripSegment[];
  TotalDuration?: number;
  Stops?: number;
  RemainingSeats?: number;
  MileageCost?: number | string;
  TotalTaxes?: number;
  TaxesCurrency?: string;
  OriginAirport?: string;
  DestinationAirport?: string;
  Cabin?: string;
  Source?: string;
  /** Layover airports in order, `Stops` of them. Search form only. */
  Connections?: string[];
  /** `"AS471, AS123"` — one per leg, `Stops + 1` of them. Search form only. */
  FlightNumbers?: string;
  /** `"AS, JL"` — the DISTINCT carrier set, **not one per leg**. Two Alaska legs
   *  give `"AS"`. Never index this by leg; read the carrier off the flight
   *  number instead. */
  Carriers?: string;
  /** Per leg when present — absent entirely on some programs. Best-effort. */
  Aircraft?: string[];
  /** Per leg when present — absent entirely on some programs. Best-effort. */
  FareClasses?: string[];
  /** Trip-level wall-clock times (the `Z` is a lie — see `localTime`). The
   *  first leg's departure and the last leg's arrival; the middle is unknown. */
  DepartsAt?: string;
  ArrivesAt?: string;
  [key: string]: unknown;
}

/** A deep link seats.aero offers for booking this availability. Several are
 *  returned — one per program that could ticket it — and exactly one is
 *  `primary`, the program that owns the row. */
export interface SeatsAeroBookingLink {
  label?: string;
  link?: string;
  primary?: boolean;
}

export interface SeatsAeroTripsResponse {
  data?: SeatsAeroTrip[];
  booking_links?: SeatsAeroBookingLink[];
  [key: string]: unknown;
}

/**
 * seats.aero's cabin words -> ours.
 *
 * `economy` and `business` are confirmed against the live capture. The other two
 * are the documented cabin vocabulary and are mapped generously because the
 * spelling is the only thing in doubt. **An unrecognised cabin is dropped, never
 * guessed** — the same rule Delta's opaque fare brands get, and for the same
 * reason: a mis-mapped cabin writes a first-class itinerary onto an economy find.
 */
const TRIP_CABIN: Record<string, Cabin> = {
  economy: "economy",
  premium: "premium",
  "premium economy": "premium",
  premiumeconomy: "premium",
  business: "business",
  first: "first",
};

/** Build a Get Trips URL. Pure. */
/**
 * A deep link this app is willing to store, or `undefined`.
 *
 * `booking_url` is the one upstream string that ends up in an `href`: the Book
 * button on the Routes page renders it directly (`pages/routes/Itinerary.tsx`).
 * It used to arrive unvalidated — whatever seats.aero put in
 * `booking_links[].link` was `String()`-ed at ingest and served to the browser —
 * so the only thing between a `javascript:` URL and an anchor was React
 * declining to render one. That is a framework behaviour, not a decision this
 * codebase made, and it would evaporate on a downgrade or a different renderer.
 *
 * Checked HERE, where the value enters, rather than where it renders, so the
 * database never holds one. A value that is only safe because of who reads it is
 * a value waiting for its second reader.
 */
function httpsLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function buildTripsUrl(availabilityId: string): string {
  return `${SEATSAERO_BASE}/trips/${encodeURIComponent(availabilityId)}`;
}

/** What one cabin's winning itinerary contributes to a stored snapshot row.
 *  Deliberately only the itinerary: enrichment never restates the price. */
export interface SeatsAeroTripDetail {
  cabin: Cabin;
  segments: Segment[];
  stops: number;
  durationMinutes?: number;
  bookingUrl?: string;
  /** Carried for assertions and notes, not written to the row. */
  milesCost: number;
  seatsAvailable: number;
}

/** The row being expanded, as known from the database. */
export interface SeatsAeroTripExpectation {
  availabilityId: string;
  /** Per-cabin award price of the stored rows, e.g. `{ economy: 37500 }`. Only
   *  these cabins are enriched, and only by trips at exactly these prices. */
  milesByCabin: Partial<Record<Cabin, number>>;
}

export interface ParseTripsResult {
  details: SeatsAeroTripDetail[];
  notes: string[];
}

/**
 * Turn a Get Trips payload into at most one itinerary per requested cabin. Pure.
 *
 * **The price filter is the load-bearing part.** One availability row expands
 * into every itinerary seats.aero knows for that (route, date, program), at
 * several prices; the summary row quotes only the cheapest per cabin. In the
 * captured SFO->NRT response the economy trips run 37,500 / 40,000 / 75,000
 * miles, and the stored find says 37,500. Collapsing without the filter would
 * pick the fastest trip overall — a 925-minute routing costing 40,000 — and
 * write it onto a find that claims 37,500. The row would then describe an
 * aeroplane you cannot have at that price.
 *
 * So: only trips whose `MileageCost` equals the stored row's are candidates, and
 * a cabin with no match is left alone. A miss stays a miss; never fall back to
 * another itinerary's price.
 *
 * **Throws** rather than returning empty when the payload is about a different
 * availability. A wrong-row payload is the one failure that would decorate a
 * find with someone else's flights, and it is indistinguishable from success
 * afterwards — the same reason Delta's `parse` rejects foreign dates.
 */
export function parseSeatsAeroTrips(
  resp: SeatsAeroTripsResponse,
  expected: SeatsAeroTripExpectation,
): ParseTripsResult {
  const notes: string[] = [];
  const trips = Array.isArray(resp.data) ? resp.data : [];

  // Guard before reading anything. Every trip and segment carries the id it
  // belongs to, so a swapped or stale payload is detectable rather than merely
  // unlikely.
  for (const t of trips) {
    const owner = String(t?.AvailabilityID ?? "");
    if (owner && owner !== expected.availabilityId) {
      throw new Error(
        `${SEATSAERO_SOURCE_ID}: trips payload is for availability ${owner}, expected ${expected.availabilityId}`,
      );
    }
  }

  // One deep link for the whole availability, so it is chosen once. `primary` is
  // the program that owns the row (the capture's primary was Alaska for an
  // `alaska` row); the rest are other programs that could also ticket it and are
  // not what `booking_url` means.
  const bookingUrl = httpsLink(
    (resp.booking_links ?? []).find((l) => l?.primary && l.link)?.link,
  );

  const wanted = new Map<Cabin, number>(
    Object.entries(expected.milesByCabin).filter(([, m]) => typeof m === "number") as [
      Cabin,
      number,
    ][],
  );

  const { details, priceMismatches, droppedCabins } = collapseTripsByCabin(trips, wanted, bookingUrl);

  if (priceMismatches) {
    notes.push(
      `${priceMismatches}/${trips.length} trips priced differently from the stored find — not this award`,
    );
  }
  const droppedTotal = Object.values(droppedCabins).reduce((a, b) => a + b, 0);
  if (droppedTotal) {
    notes.push(
      `dropped ${droppedTotal} trips with unrecognised cabins: ${Object.entries(droppedCabins)
        .map(([c, n]) => `${c}×${n}`)
        .join(", ")}`,
    );
  }
  for (const [cabin] of wanted) {
    if (!details.some((d) => d.cabin === cabin)) {
      notes.push(`no ${cabin} trip at the stored price — left as a summary`);
    }
  }

  return { details, notes };
}

/**
 * Pick at most one itinerary per requested cabin, at exactly the stored price.
 *
 * Shared by BOTH paths that turn trips into detail — `parseSeatsAeroTrips` for
 * `GET /trips/{id}`, and `normalizeSeatsAero` for the trips a search now embeds.
 * That sharing is the point: the price filter and the collapse rule are the two
 * things that decide *which real aeroplane a stored find describes*, and two
 * implementations of that would eventually disagree about the same row.
 *
 * `wanted` is the per-cabin award price of the rows being described. A trip
 * priced differently is a DIFFERENT award that happens to share an id, and a
 * cabin with no match is left alone — a miss stays a miss. Pure.
 */
export function collapseTripsByCabin(
  trips: SeatsAeroTrip[],
  wanted: Map<Cabin, number>,
  bookingUrl?: string,
): {
  details: SeatsAeroTripDetail[];
  priceMismatches: number;
  droppedCabins: Record<string, number>;
} {
  const candidates: (SeatsAeroTripDetail & Collapsible)[] = [];
  const droppedCabins: Record<string, number> = {};
  let priceMismatches = 0;

  for (const t of trips) {
    if (!t || typeof t !== "object") continue;
    const raw = String(t.Cabin ?? "").trim().toLowerCase();
    const cabin = TRIP_CABIN[raw];
    if (!cabin) {
      if (raw) droppedCabins[raw] = (droppedCabins[raw] ?? 0) + 1;
      continue;
    }

    const want = wanted.get(cabin);
    if (want == null) continue; // a cabin we hold no row for
    const milesCost = num(t.MileageCost);
    if (milesCost !== want) {
      priceMismatches++;
      continue;
    }

    const segments = tripSegments(t, cabin);
    if (segments.length === 0) continue; // nothing to add over the summary

    const stops = typeof t.Stops === "number" ? t.Stops : segments.length - 1;
    candidates.push({
      cabin,
      segments,
      stops,
      durationMinutes: typeof t.TotalDuration === "number" ? t.TotalDuration : undefined,
      bookingUrl,
      milesCost,
      seatsAvailable: Math.max(1, num(t.RemainingSeats)),
      // `Collapsible`'s remaining fields. flightDate is constant across the
      // trips under one availability, so it plays no part in the ordering.
      flightDate: "",
    });
  }

  // The shared rule, not a local one: cheapest miles (already equal), then most
  // seats, then fewest stops, then shortest. Reusing it is what keeps a detailed
  // row's itinerary consistent with the one ingest would have picked.
  const details = collapseBy(candidates, (c) => c.cabin).map(
    ({ cabin, segments, stops, durationMinutes, bookingUrl: url, milesCost, seatsAvailable }) => ({
      cabin,
      segments,
      stops,
      durationMinutes,
      bookingUrl: url,
      milesCost,
      seatsAvailable,
    }),
  );

  return { details, priceMismatches, droppedCabins };
}

/** The carrier a flight number belongs to. IATA codes are two characters and may
 *  lead with a digit (`9W`), so this is a prefix match, not a letter match. */
const carrierOf = (flightNumber: string): string =>
  /^[A-Z0-9]{2}/.exec(flightNumber.toUpperCase())?.[0] ?? "";

/**
 * Map one trip to our `Segment[]`, from whichever shape it arrived in.
 *
 * Prefers `AvailabilitySegments` (the `/trips/{id}` form) because it is strictly
 * richer — it is the only form that knows when each individual leg goes. Falls
 * back to the airport chain a search-embedded trip carries.
 */
function tripSegments(t: SeatsAeroTrip, cabin: Cabin): Segment[] {
  const raw = t.AvailabilitySegments;
  if (Array.isArray(raw) && raw.length) {
    const ordered = [...raw]
      .filter((s) => s && typeof s === "object")
      // `Order` is authoritative — do not trust array order.
      .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));

    return ordered.map((s) => {
      const flightNumber = String(s.FlightNumber ?? "").trim();
      return {
        from: String(s.OriginAirport ?? "").toUpperCase(),
        to: String(s.DestinationAirport ?? "").toUpperCase(),
        // Flight numbers arrive carrier-prefixed ("JX11"). `flightLabel` in the
        // SPA already strips a duplicated prefix, so keeping the raw value and
        // deriving the carrier from it is one convention for the whole app.
        carrier: carrierOf(flightNumber),
        flightNumber: flightNumber || undefined,
        aircraft: s.AircraftName || undefined,
        fareClass: (s.FareClass as string | undefined) || undefined,
        departsAt: localTime(s.DepartsAt),
        arrivesAt: localTime(s.ArrivesAt),
        // Per-leg, so a mixed-cabin itinerary reports each leg honestly rather
        // than painting the whole trip with the cabin that was searched for.
        cabin: TRIP_CABIN[String(s.Cabin ?? "").trim().toLowerCase()] ?? cabin,
      };
    });
  }
  return chainSegments(t, cabin);
}

/**
 * Rebuild the legs of a search-embedded trip, which has no segment array.
 *
 * The airport chain is `[OriginAirport, ...Connections, DestinationAirport]` and
 * the flights are `FlightNumbers` split on commas. **Those two are the load-
 * bearing pair and they must agree**: `n` airports means `n - 1` flights. On the
 * captured payload that held for 9 of 9 trips, `Connections.length === Stops` and
 * `FlightNumbers.length === Stops + 1`.
 *
 * When they disagree we return NOTHING rather than zipping a short list against a
 * long one. A guessed leg is worse than a summary: the row would name an
 * aeroplane that is not on the ticket, and nothing downstream could tell.
 *
 * `Aircraft` and `FareClasses` are genuinely optional — absent on `azul` and
 * `american` rows in the same response — so they are attached per leg only when
 * present at the right length, and their absence is not a reason to drop a trip.
 *
 * Per-leg times do not exist in this form. The trip's own `DepartsAt`/`ArrivesAt`
 * are the FIRST leg's departure and the LAST leg's arrival, so they are placed
 * there and nowhere else. A middle leg with no times is the truth; inventing them
 * from `TotalDuration` would render a layover that was never measured.
 */
function chainSegments(t: SeatsAeroTrip, cabin: Cabin): Segment[] {
  const from = String(t.OriginAirport ?? "").toUpperCase();
  const to = String(t.DestinationAirport ?? "").toUpperCase();
  if (!from || !to) return [];

  const via = (Array.isArray(t.Connections) ? t.Connections : [])
    .map((c) => String(c ?? "").trim().toUpperCase())
    .filter(Boolean);
  const chain = [from, ...via, to];

  const flights = String(t.FlightNumbers ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (flights.length !== chain.length - 1) return [];

  const aircraft = Array.isArray(t.Aircraft) ? t.Aircraft : [];
  const fareClasses = Array.isArray(t.FareClasses) ? t.FareClasses : [];
  const perLeg = (list: string[], i: number): string | undefined =>
    list.length === flights.length ? String(list[i] ?? "").trim() || undefined : undefined;

  const last = flights.length - 1;
  return flights.map((flightNumber, i) => ({
    from: chain[i]!,
    to: chain[i + 1]!,
    // NOT `Carriers[i]` — that field is the distinct set, so a two-leg all-AS
    // trip lists one carrier and a mixed trip would misalign from leg two on.
    carrier: carrierOf(flightNumber),
    flightNumber,
    aircraft: perLeg(aircraft, i),
    fareClass: perLeg(fareClasses, i),
    departsAt: i === 0 ? localTime(t.DepartsAt) : undefined,
    arrivesAt: i === last ? localTime(t.ArrivesAt) : undefined,
    cabin,
  }));
}

/**
 * Strip the `Z` seats.aero puts on a local time.
 *
 * Proven by arithmetic in the live capture, not assumed: `JL67` SEA->NRT is
 * stamped `2026-12-09T11:50:00Z` -> `2026-12-10T15:05:00Z`, 27h15 apart, beside
 * its own `Duration: 615`. Those are wall-clock times at each airport. Keeping
 * the suffix would assert UTC, and the first consumer to do date maths on it
 * would move every flight by the airport's offset.
 */
function localTime(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  return s.endsWith("Z") ? s.slice(0, -1) : s;
}

export interface SeatsAeroTripsOptions {
  apiKey: string;
  /** Share ONE transport across a batch of enrichments: "the key was refused" is
   *  a fact about the source, not about one row, and `makeTransport` is sticky
   *  so the rest stop asking. */
  transport?: FetchLike;
  signal?: AbortSignal;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface SeatsAeroTripsResult extends ParseTripsResult {
  quota?: SourceQuotaObservation;
  call: SeatsAeroCall;
}

/**
 * Fetch and parse one availability row's itineraries.
 *
 * **Throwing is the failure protocol**, as everywhere else here. An empty result
 * from a refused call would read as "seats.aero has no itinerary for this find",
 * and the caller would stamp `enriched_at` and stop offering to try again.
 */
export async function runSeatsAeroTrips(
  expected: SeatsAeroTripExpectation,
  opts: SeatsAeroTripsOptions,
): Promise<SeatsAeroTripsResult> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.transport ?? makeTransport({ log });
  const headers = seatsAeroHeaders(opts.apiKey);
  const url = buildTripsUrl(expected.availabilityId);
  const startedAt = now();
  const base = {
    index: 1,
    method: "GET",
    url,
    requestHeaders: { ...headers, "Partner-Authorization": SEATSAERO_REDACTED },
    startedAt,
  };

  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: opts.signal });
  } catch (err) {
    const status = err instanceof BlockedError && err.status > 0 ? err.status : undefined;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      call: {
        ...base,
        status,
        ok: false,
        durationMs: now() - startedAt,
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      } satisfies SeatsAeroCall,
    });
  }

  const text = await res.text();
  const call: SeatsAeroCall = {
    ...base,
    status: res.status,
    ok: res.ok,
    durationMs: now() - startedAt,
    responseHeaders: headersToObject(res.headers),
    bytes: text.length,
  };
  // Read the allowance even off a failure — a 429 is exactly when it matters.
  const quota = parseQuotaHeaders(res.headers, SEATSAERO_SOURCE_ID, now());

  if (!res.ok) {
    throw Object.assign(new Error(`${SEATSAERO_SOURCE_ID}: HTTP ${res.status}`), {
      call: { ...call, error: text.slice(0, 500) },
      quota,
    });
  }

  const body = JSON.parse(text) as SeatsAeroTripsResponse;
  call.rows = body.data?.length ?? 0;
  const parsed = parseSeatsAeroTrips(body, expected);
  log(
    `${SEATSAERO_SOURCE_ID}: ${call.rows} trips -> ${parsed.details.length} cabins enriched`,
    { availabilityId: expected.availabilityId },
  );
  return { ...parsed, quota, call };
}

// ---------------------------------------------------------------------------
// The route graph — GET /partnerapi/routes?source=<name>
// ---------------------------------------------------------------------------
//
// Which city pairs a program's award inventory is monitored on. Reference data,
// not availability: it claims no coverage, writes no snapshot, and is not a
// source under docs/SOURCES.md. It backs the Library's seats.aero pane
// (docs/SEATS-AERO.md §12), one metered call per source, on a button press.
//
// Two answers come back looking alike, and telling them apart is the point:
// a graph, and `200 []` — which is what an unrecognised source name returns,
// silently. That is why the caller records the fetch itself and not just its
// rows, and why an empty array must never be turned into a throw here.

/** The eight sources seats.aero really has that this app does not map onto a
 *  program, because none is reachable from a currency the couple holds. Listed
 *  so the pane can show the whole picture rather than only our slice; promoted
 *  out of SEATSAERO_PROGRAM_MAP's doc comment so it is data, not prose. */
export const SEATSAERO_UNMAPPED_SOURCES: readonly string[] = [
  "velocity",
  "smiles",
  "azul",
  "copa",
  "finnair",
  "saudia",
  "ethiopian",
  "eurobonus",
];

/** Names that LOOK like sources and return `200 []`. Every one was a real guess
 *  someone made. Kept so the pane can demonstrate what `empty` means without
 *  the operator having to invent a wrong name. */
export const SEATSAERO_ZERO_ROUTE_NAMES: readonly string[] = [
  "britishairways",
  "ana",
  "cathay",
  "eva",
  "connectmiles",
];

/** Every source key the pane offers, mapped ones first. */
export const SEATSAERO_SOURCE_CATALOGUE: readonly string[] = [
  ...SEATSAERO_SOURCES,
  ...SEATSAERO_UNMAPPED_SOURCES,
];

export function buildRoutesUrl(source: string): string {
  return `${SEATSAERO_BASE}/routes?source=${encodeURIComponent(source)}`;
}

/**
 * One pair, normalized — before it is a database row.
 *
 * The RAW element is `SeatsAeroRoute` above, already declared for the `Route`
 * object nested in an availability row. That is not a coincidence to work
 * around: `/partnerapi/routes` returns exactly that object, standalone, so the
 * two really are the same wire shape and only one declaration is needed.
 */
export interface SeatsAeroGraphRoute {
  source: string;
  origin: string;
  destination: string;
  originRegion: string | null;
  destinationRegion: string | null;
  distanceMi: number | null;
  routeId: string | null;
}

export interface ParsedSeatsAeroRoutes {
  routes: SeatsAeroGraphRoute[];
  /** Rows missing an endpoint. Dropped rather than defaulted, and counted so
   *  the loss is a number rather than a silence. */
  malformed: number;
  /** Duplicate (origin, destination) pairs within one source, dropped keeping
   *  the first. `seatsaero_routes` has that as its PRIMARY KEY, and one
   *  duplicate would otherwise abort the whole transaction and waste the call. */
  duplicates: number;
}

/**
 * Parse the route graph. Pure, and the whole of what the unit test asserts on.
 *
 * The top level is a bare array — verified live on 2026-08-18 against `alaska`
 * (8,130 rows) and `aeroplan` (8,338). `{data:[…]}` is accepted anyway because
 * every other endpoint on this API wraps, and being wrong about that would look
 * like a program that flies nowhere.
 *
 * **`NumDaysOut` is not read, because it does not arrive.** The published
 * example at developers.seats.aero/reference/get-routes-1 shows it; zero of
 * those 16,468 rows carried it, `aeroplan` included — which is the very source
 * that example is written from. Anything wanting a per-route monitoring horizon
 * has no data behind it here.
 */
export function parseSeatsAeroRoutes(body: unknown, source: string): ParsedSeatsAeroRoutes {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown[] } | null)?.data)
      ? (body as { data: unknown[] }).data
      : [];

  const routes: SeatsAeroGraphRoute[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let duplicates = 0;

  for (const raw of rows) {
    // Not every element is an object: a fixture trimmed by the probe carries a
    // literal "<trimmed N more>" string in the array, and a parser that assumed
    // otherwise would throw on its own test data.
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const origin = str(r.OriginAirport);
    const destination = str(r.DestinationAirport);
    if (!origin || !destination) {
      malformed++;
      continue;
    }
    const key = `${origin} ${destination}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    routes.push({
      // The payload's own `Source`, not the requested one — the same rule the
      // rest of this file follows about reading endpoints off the answer.
      source: str(r.Source) || source,
      origin,
      destination,
      originRegion: str(r.OriginRegion) || null,
      destinationRegion: str(r.DestinationRegion) || null,
      distanceMi: distance(r.Distance),
      routeId: str(r.ID) || null,
    });
  }

  return { routes, malformed, duplicates };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/** Measured as an integer on every observed row, but coerced rather than cast:
 *  this API has already shipped one field as a string on one endpoint and a
 *  number on another (`[C]MileageCost`). */
function distance(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export interface SeatsAeroRoutesOptions {
  apiKey: string;
  transport?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
}

export interface SeatsAeroRoutesResult extends ParsedSeatsAeroRoutes {
  quota?: SourceQuotaObservation;
  httpStatus: number;
  durationMs: number;
  bytes: number;
}

/**
 * Fetch one source's graph.
 *
 * **Throwing is the failure protocol.** A refused call must not come back as
 * zero routes: that is indistinguishable from the `200 []` that means "this
 * source name is not real", and writing that verdict onto a network blip would
 * be the one wrong answer this whole surface exists to prevent.
 */
export async function runSeatsAeroRoutes(
  source: string,
  opts: SeatsAeroRoutesOptions,
): Promise<SeatsAeroRoutesResult> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.transport ?? makeTransport({});
  const headers = seatsAeroHeaders(opts.apiKey);
  const url = buildRoutesUrl(source);
  const startedAt = now();

  const res = await fetchImpl(url, { method: "GET", headers, signal: opts.signal });
  const text = await res.text();
  // Read the allowance even off a failure — a 429 is exactly when it matters.
  const quota = parseQuotaHeaders(res.headers, SEATSAERO_SOURCE_ID, now());

  if (!res.ok) {
    throw Object.assign(new Error(`${SEATSAERO_SOURCE_ID}: HTTP ${res.status}`), {
      httpStatus: res.status,
      body: text.slice(0, 500),
      quota,
    });
  }

  return {
    ...parseSeatsAeroRoutes(JSON.parse(text), source),
    quota,
    httpStatus: res.status,
    durationMs: now() - startedAt,
    bytes: text.length,
  };
}

// --- small pure helpers ----------------------------------------------------

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "true";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `["AS","AA"]`, `"AS, AA"` and `"AS"` all appear in the wild. */
function splitAirlines(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Accept `YYYY-MM-DD` or a full ISO timestamp; return the ISO date or "". */
function isoDate(v: unknown): string {
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

/** seats.aero stamps are ISO strings; be tolerant of epoch numbers too. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}
