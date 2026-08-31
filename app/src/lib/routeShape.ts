import type { TrackedRoute } from "../api";

/**
 * Pure shape helpers for a stored tracked route: its JSON-array columns, and the
 * calendar arithmetic that reads them.
 *
 * A separate module from the page that uses them so `roundtrip.ts` — and its
 * test — can parse a route without pulling MUI, Emotion and the router into the
 * graph. `components/pages/routes/RoutesPage.tsx` imports them back; this is a move, not a copy.
 *
 * The date helpers mirror `addDaysISO` / `daysBetween` in
 * `api/src/util/dates.ts`, and are deliberately kept as copies:
 * `domain/window.ts` is not part of the wire contract, and putting two
 * date helpers into it purely to share them would widen that contract for no
 * gain. Four lines of calendar arithmetic is the cheaper duplicate.
 */

/**
 * One side of a route's airport SET, from the JSON column with the scalar as
 * fallback.
 *
 * `origins`/`destinations` are the authoritative sets and `origin`/`destination`
 * are the route's PRIMARY airport each side — so for a row carrying no array the
 * scalar IS the whole set. Never throws: these are strings out of a database
 * column, and a malformed one must narrow the answer, not blank the page.
 */
export function parseCodes(json: string | null, fallback: string): string[] {
  if (json) {
    try {
      const v = JSON.parse(json);
      if (Array.isArray(v)) return v.map(String);
    } catch {
      /* fall through */
    }
  }
  return fallback ? [fallback] : [];
}

/**
 * A stored FILTER column (`cabins`, `currencies`) into a plain code list.
 *
 * Distinct from `parseCodes` in what null means: there is no scalar to fall back
 * to, and `NULL` means "no filter", never "none". Callers read `[]` as unfiltered.
 */
export function parseCodeList(json?: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

/** Both ends of a route's airport sets in one call. */
export function routeSets(r: TrackedRoute): { origins: string[]; destinations: string[] } {
  return {
    origins: parseCodes(r.origins, r.origin),
    destinations: parseCodes(r.destinations, r.destination),
  };
}

/**
 * Add days to an ISO date (YYYY-MM-DD).
 *
 * UTC math throughout, so a daylight-saving boundary can never shift the
 * calendar day — which matters here because the result is compared against
 * `flight_date`, a date string with no time in it at all.
 */
export function addDaysISO(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. UTC, as above. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return NaN;
  return Math.round((tb - ta) / 86_400_000);
}
