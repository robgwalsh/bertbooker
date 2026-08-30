// What pressing Search will cost, before it is pressed.
//
// A deliberately simplified restatement of `estimateSearchCalls` in
// `api/src/models/route.ts` — it quotes a RANGE for a form that is still being
// typed into, where the real planner works from a validated spec. The two are
// allowed to differ; what they must not differ on is the constants, which is
// why those are imported rather than copied.

import { SEATSAERO_CHUNK_DAYS, SEATSAERO_MAX_CHUNKS, SEATSAERO_MAX_PAGES } from "../../api";

export interface RouteShape {
  origins: string[];
  destinations: string[];
}

/**
 * What pressing Search will spend, as a range.
 *
 * The headline is that pairs are nearly free: seats.aero takes comma-delimited
 * airports, so a whole cross product is one call and only the number of date
 * chunks adds any. Quoted as floor..ceiling because the true figure depends on
 * how many rows the window holds, which is the thing a search finds out.
 */
export function estimateCalls(
  form: RouteShape,
  dateStart: string,
  dateEnd: string,
  roundTrip = false,
) {
  const days =
    Math.round(
      (Date.parse(`${dateEnd}T00:00:00`) - Date.parse(`${dateStart}T00:00:00`)) / 86_400_000,
    ) + 1;
  const chunks = Math.max(
    1,
    Math.min(SEATSAERO_MAX_CHUNKS, Math.ceil((Number.isFinite(days) ? days : 1) / SEATSAERO_CHUNK_DAYS)),
  );
  // Round trip unions the two sides, so the pair count is the square of the
  // combined set minus its self-pairs — and the CALL count is untouched, which
  // is the headline. Mirrors `estimateSearchCalls`/`roundTripSpec` in
  // api/src/models/route.ts.
  const pairs = roundTrip
    ? (() => {
        const both = new Set([...form.origins, ...form.destinations]);
        return both.size * both.size - both.size;
      })()
    : form.origins.length * form.destinations.length;
  return { pairs, chunks, floor: chunks, ceiling: chunks * SEATSAERO_MAX_PAGES };
}
