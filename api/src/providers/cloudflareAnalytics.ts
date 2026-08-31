import type { Env } from "../bindings.js";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Cloudflare's own numbers lag by a few minutes, so asking more often than
 *  this buys nothing. */
const CACHE_MS = 300_000;

/** Long enough for a healthy answer, short enough that a wedged analytics API
 *  cannot hold an app-bar poll open. On expiry the chips simply do not draw. */
const TIMEOUT_MS = 5_000;

/**
 * NO `databaseId` FILTER, and that is the correct scope rather than laziness.
 * The row allowance is an ACCOUNT-level quota, so the number the ceiling is
 * actually measured against is every D1 database in the account summed — which
 * is also why a second database appearing would move this chip without any
 * change here, correctly.
 */
const QUERY = `query BertBookerD1Usage($account: string!, $day: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $day, date_leq: $day }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

export interface D1RowTotals {
  rowsRead: number;
  rowsWritten: number;
}

/** 'YYYY-MM-DD' in UTC — when the allowance resets, wherever the caller is. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nonNegative(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * The GraphQL body, reduced to two numbers — or `undefined` if it cannot be.
 *
 * **Never returns a zero it did not read.** A missing field, a `null`, a
 * GraphQL `errors` array, an unrecognised shape: every one of them yields
 * `undefined`, because the SPA draws no chip for an absent meter but draws a
 * FULL allowance for a zero. "We could not ask" and "nothing has been spent"
 * are the two readings that must never be confused, and the second is the one
 * that reassures.
 *
 * This is the same guard, for the same reason, as the explicit null check at
 * the top of `parseQuotaHeaders` in `seatsaero.ts` — `Number(null)` is 0, and a
 * quota fabricated out of a missing value is worse than no quota at all.
 */
export function parseD1Analytics(json: unknown): D1RowTotals | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const root = json as Record<string, unknown>;

  // A GraphQL 200 can still be a failure. Partial data alongside errors is
  // exactly the case that would otherwise under-report and read as headroom.
  if (Array.isArray(root.errors) && root.errors.length > 0) return undefined;

  const data = root.data as Record<string, unknown> | undefined;
  const viewer = data?.viewer as Record<string, unknown> | undefined;
  const accounts = viewer?.accounts;
  if (!Array.isArray(accounts)) return undefined;

  let rowsRead = 0;
  let rowsWritten = 0;
  let sawGroup = false;

  for (const account of accounts) {
    if (typeof account !== "object" || account === null) continue;
    const groups = (account as Record<string, unknown>).d1AnalyticsAdaptiveGroups;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== "object" || group === null) continue;
      const sum = (group as Record<string, unknown>).sum as Record<string, unknown> | undefined;
      const read = nonNegative(sum?.rowsRead);
      const written = nonNegative(sum?.rowsWritten);
      if (read === undefined || written === undefined) continue;
      rowsRead += read;
      rowsWritten += written;
      sawGroup = true;
    }
  }

  // An account with a D1 database that has been queried today always has a
  // group. No group at all means the query answered about something other than
  // what we asked, so say nothing rather than report a quiet zero.
  return sawGroup ? { rowsRead, rowsWritten } : undefined;
}

/**
 * Module-scope, and therefore BEST-EFFORT ONLY: an isolate lives as long as it
 * lives and an account is served by many of them, so this trims repeat asks
 * within one isolate rather than bounding the request rate globally. That is
 * enough — the poll behind it is one app bar, every five minutes.
 *
 * Keyed on the day so a cache entry cannot survive the midnight reset and
 * report yesterday's total against today's allowance.
 */
let cached: { at: number; day: string; totals: D1RowTotals } | undefined;

/**
 * Today's totals, or `undefined` when Cloudflare could not be asked — no
 * credentials, a timeout, a non-200, or a body that did not parse. Every one of
 * those is the same answer to the caller, on purpose: the chip either has a
 * number it trusts or it does not draw.
 */
export async function fetchD1RowTotals(env: Env, now: number): Promise<D1RowTotals | undefined> {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) return undefined;

  const day = utcDay(now);
  if (cached && cached.day === day && now - cached.at < CACHE_MS) return cached.totals;

  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY, variables: { account, day } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const totals = parseD1Analytics(await res.json());
    if (totals) cached = { at: now, day, totals };
    return totals;
  } catch {
    // A timeout, a DNS failure, a body that is not JSON. The app bar is not the
    // place to surface any of them, and the alternative to swallowing it here is
    // a failed request that hides the seats.aero chip beside it.
    return undefined;
  }
}
