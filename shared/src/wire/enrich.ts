import type { SourceTaskStatus } from "../ingest/types.js";

/**
 * Availability rows one "Enrich all" may expand.
 *
 * This is a **Worker subrequest budget**, the same per-request ceiling the search
 * path keeps with `MAX_CALLS_PER_REQUEST` (25), and one enrichment is one call.
 * Unlike search it does not resume across requests: there is no `run_continue`
 * here, so the cap is the end of the sweep rather than a pause in it. It is also
 * a spend ceiling — 25 calls is a visible dent in a 1000-call day and should be a
 * decision, not a side effect of a wide date window.
 *
 * When it bites, the run says so (`capped`, with the true total). A silently
 * truncated sweep reads as "everything is enriched now", which it is not.
 *
 * The SPA quotes this in the confirm dialog so the cost is stated before the
 * request is made. It used to hold its own copy of the number; the server
 * enforces it either way, but two constants meant the dialog could quote a
 * figure the Worker had stopped honouring.
 */
export const ENRICH_MAX_PER_RUN = 25;

/**
 * `POST /api/finds/enrich` — the result of enriching one find.
 *
 * One availability id covers all four cabins, so the single call the user is
 * paying for expands every sibling row and this reports them all. The SPA reads
 * it as `EnrichResult`.
 */
export interface EnrichOutcome {
  /** Cabins whose stored row now carries a real itinerary. */
  enriched: { cabin: string; stops: number; durationMinutes?: number; flights: string }[];
  /** Cabins the call covered but could not improve, and why. */
  skipped: { cabin: string; reason: string }[];
  notes: string[];
  quotaRemaining?: number;
}

/** One NDJSON frame from `POST /api/tracked-routes/:id/enrich`. Same terminal
 *  frame rule as the search stream, but only two of them — there is no
 *  `run_continue` here, because enrichment does not resume. */
export type EnrichEvent =
  | {
      type: "run_start";
      /** Availability rows this run will expand — one call each. */
      targets: number;
      /** How many were eligible in total. Differs from `targets` when capped. */
      totalTargets: number;
      capped: boolean;
    }
  | {
      type: "item";
      index: number;
      total: number;
      flightDate: string;
      program: string;
      /** The shared failure vocabulary, straight from `classifyError`. `blocked`
       *  at 401 is a wrong key and at 429 a spent day; those want opposite
       *  responses, so the distinction has to survive to the UI. */
      status: SourceTaskStatus;
      cabins: string[];
      error?: string;
    }
  | { type: "quota"; remaining: number; observedAt: number }
  | {
      type: "run_done";
      enriched: number;
      failed: number;
      /** Cabins that came back with no itinerary at the stored price. */
      empty: number;
      calls: number;
      durationMs: number;
      capped: boolean;
      /** Eligible rows this run did NOT reach, because of the per-run cap. */
      remaining: number;
    }
  | { type: "error"; message: string };
