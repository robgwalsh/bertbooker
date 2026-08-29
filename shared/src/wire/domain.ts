// The domain vocabulary the wire speaks — DECLARED here, not borrowed.
//
// `Cabin`, `Segment`, and the rest of the shared domain vocabulary are
// declared in this file; `api/src/domain/types.ts` re-exports them from here,
// the same direction `./seatsaero.ts` uses. Declaring them here keeps
// Worker-only code (`diffAvailability`, `planRoute`, `PROGRAM_SEEDS` — none of
// which run in a browser) out of `shared/`: nothing in `wire/` needs to quote
// a type name out of it.
//
// Everything below is a type or a string union — no runtime code, nothing that
// names `fetch` or `D1Database`. `../tsconfig.wire.json` compiles this directory
// alone, with neither DOM nor `@cloudflare/workers-types`, which is what keeps
// that true.

// ---- Cabins and itineraries (api/src/domain/types.ts re-exports these) ----

export type Cabin = "economy" | "premium" | "business" | "first";

/** A point currency the couple holds and can transfer/redeem from. */
export type Currency =
  | "chase_ur"
  | "capital_one"
  | "bilt"
  | "citi_ty"
  | "amex_mr"
  | "direct"; // miles/points held directly in a loyalty program

export type Alliance = "star" | "oneworld" | "skyteam" | null;

/** One flown segment within an award itinerary. */
export interface Segment {
  from: string; // IATA
  to: string; // IATA
  carrier: string; // marketing carrier IATA, e.g. "LH"
  flightNumber?: string;
  aircraft?: string;
  /** Booking class letter, e.g. "O" or "T". Which award bucket the seat came out
   *  of, which is the thing you quote to an agent when a website disagrees. */
  fareClass?: string;
  /** ISO local. Absent is a real answer, and a common one: a trip embedded in a
   *  search response carries only the whole trip's endpoints, so its middle legs
   *  genuinely have no times. Never interpolate them from a total duration. */
  departsAt?: string;
  arrivesAt?: string;
  cabin?: Cabin;
}

// ---- Change detection (api/src/domain/diff.ts re-exports these) ----

export type ChangeType = "new" | "more_seats" | "price_drop" | "gone";

/** A change flattened for the wire — enough to render a row without shipping
 *  two whole `AvailabilityResult`s per change. Pure projection. */
export interface ChangeSummary {
  type: ChangeType;
  key: string;
  flightDate: string;
  program: string;
  cabin: string;
  /** The city pair. Recoverable from `key` only by knowing the flight date is
   *  its last ten characters — parseable, fragile, and the alert digest needs
   *  one line per change to say where the seat is. Optional because
   *  `search_runs.changes_json` holds blobs written before these existed.
   *
   *  Note what these are NOT for: alert FILTERING does not read them. That
   *  question — "would this route's own pane show this find?" — is answered by
   *  intersecting with the finds query, so the route's cabin/currency/nonstop
   *  rules keep exactly one implementation. See `api/src/alerts/select.ts`. */
  origin?: string;
  destination?: string;
  /** Absent for "gone" (there is no current result). */
  milesCost?: number;
  seatsAvailable?: number;
  /** Absent for "new" (there is no prior result). */
  previousMilesCost?: number;
  previousSeats?: number;
}

/**
 * The four transitions an alert can fire on.
 *
 * Structurally `ChangeType` — the thing `diffAvailability` classifies — under
 * the name the wire and the SPA use for it. Note that the *display order* is NOT
 * here: `ALL_ALERT_TYPES` in `api/src/alerts/select.ts` and the SPA's
 * `ALERT_TYPES` list the same four members in different orders, and the SPA's
 * order is what the route form's checkboxes render in. Unifying the arrays would
 * silently reorder that form, so only the type is shared.
 */
export type AlertType = ChangeType;

// ---- Run and task status (api/src/ingest/types.ts re-exports these) ----

/** How a single unit of gathering work ended.
 *
 *  The distinction that matters: `empty` means "I looked and there is no award
 *  space"; everything below it means "I did not get a usable answer". Those
 *  produce identical availability data and must never produce identical
 *  metadata, because only the first one is allowed to claim coverage.
 *
 *  `COVERAGE_CLAIMING_STATUSES` — the invariant that keeps that list to exactly
 *  {ok, empty} — is a runtime value and stays on the Worker's side, in
 *  `api/src/ingest/types.ts`. */
export type SourceTaskStatus =
  /** Looked, found something. */
  | "ok"
  /** Looked, genuinely nothing there. Claims coverage — this is the point. */
  | "empty"
  /** Threw. Claims nothing. */
  | "failed"
  /** Never attempted (horizon, filter, aborted run). Claims nothing. */
  | "skipped"
  /** Refused at the door — 403/428/444/challenge page. Claims nothing. */
  | "blocked"
  /** A challenge appeared and needs a human. Claims nothing. */
  | "challenged"
  /** Ran out of time. Claims nothing. */
  | "timeout";

export type RunStatus = "running" | "ok" | "partial" | "failed" | "aborted";
