// The app bar's three meters as numbers, with no chip around them.
//
// One module for all three because they share one tone scale and one clock:
// both allowances reset at 00:00 UTC, and a meter at 8% left has to look
// equally alarmed whichever one it is, or the cluster stops reading as one
// thing. What they do NOT share is what gets observed, which is the whole
// reason `QuotaSummary` splits from `SourceQuotaSummary` below.
//
// Split out of `components/QuotaIndicator.tsx` so it is reachable: the vitest
// glob is `*.test.ts` only, and a `.test.tsx` is not skipped — it is never
// collected at all, silently, with a green run. Anything pure that wants a test
// has to live in a `.ts` file, which is the rule `lib/` exists to state.
//
// `quotaToneColor` takes a MUI `Theme` but imports it as a type only, so this
// module stays Node-testable with no DOM.

import {
  SEATSAERO_SOURCE_ID,
  type D1Usage,
  type D1UsagePage,
  type QuotaPage,
  type SourceQuota,
} from "../api";
import { sinceLabel } from "./format";
import type { Theme } from "@mui/material/styles";

/** Display names for metered source ids. The id itself is a permanent database
 *  value; this is just what a human should read. */
const METERED_SOURCE_LABEL: Record<string, string> = {
  [SEATSAERO_SOURCE_ID]: "seats.aero Partner API",
};

/** Assumed daily ceiling when the vendor's response didn't state one. Only used
 *  to draw the meter — never to fill in a `remaining` we didn't observe. */
const ASSUMED_LIMIT = 1000;

/**
 * The metered source the app actually spends. `QuotaSplash` leads with this one
 * when several have reported.
 *
 * **This is now an import, and that is the whole point of the wire module.** It
 * has to be byte-identical to the literal the Worker writes into
 * `source_quota.source`, and for a long time it was not: it sat on `api:seatsaero`
 * after a migration re-keyed the database to `seatsaero`, and the failure was
 * silent in exactly the way an id mismatch always is — every lookup matched
 * nothing, `quotaLeft` was permanently `undefined`, and the chip fell back to
 * rendering the raw id instead of a number. It went unnoticed for months.
 *
 * There was no shared constant to import then, because the SPA mirrored the
 * Worker's wire types by hand. There is one now, and this alias is kept only so
 * the name still reads as what it means at the call sites.
 */
export const PRIMARY_METERED_SOURCE = SEATSAERO_SOURCE_ID;

/**
 * The DOM id of the app-bar chip.
 *
 * The one place in this app that addresses a node by id, and it earns it: the
 * unlock splash shrinks *into* this element, so it has to measure where the
 * element ended up. Nothing reads it for state.
 */
export const QUOTA_CHIP_ID = "quota-indicator";

/** ms until the next 00:00 UTC, which is when seats.aero's allowance resets. */
function msUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

function untilLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** "4h 12m" until the allowance resets. */
export function quotaResetLabel(now: number): string {
  return untilLabel(msUntilUtcMidnight(now));
}

/**
 * One meter, reduced to what a CHIP needs and nothing more.
 *
 * Deliberately says nothing about where the number came from, because three
 * meters now render through it and only one of them is a metered source. The
 * seats.aero-specific rows live on `SourceQuotaSummary` below.
 */
export interface QuotaSummary {
  source: string;
  label: string;
  /** What's left today. Observed directly for seats.aero; derived by
   *  subtraction for the D1 meters, which observe the spend instead. */
  remaining: number;
  limit: number;
  /** 0–100, for a meter. */
  pct: number;
  /**
   * What has been SPENT, when that is the half actually observed.
   *
   * Only the D1 meters set it. seats.aero reports what is left and never says
   * how many calls were made, so filling this in there would mean subtracting
   * from an assumed limit and presenting the guess as an observation.
   */
  used?: number;
  /**
   * How alarmed to look.
   *
   * A tone rather than a colour, because these are pure functions of the
   * payload with no theme to read — and a hardcoded traffic light stayed the
   * old near-black theme's coral and amber under every other palette. Every
   * consumer turns it into a colour with `quotaToneColor`.
   */
  tone: QuotaTone;
}

/** A metered SOURCE's allowance, which carries the stored rows behind it.
 *  `summarizeQuota` returns these; the D1 meters have no such rows and are
 *  plain `QuotaSummary`. */
export interface SourceQuotaSummary extends QuotaSummary {
  /** Today's row, absent when nothing has been spent since the reset. */
  today?: SourceQuota;
  /** The most recent observation on any day. */
  lastSeen: SourceQuota;
}

export type QuotaTone = "low" | "warn" | "ok";

export function quotaToneColor(tone: QuotaTone, theme: Theme): string {
  return tone === "low"
    ? theme.palette.error.main
    : tone === "warn"
      ? theme.palette.warning.main
      : theme.palette.secondary.main;
}

/**
 * The stored quota rows, per source, as something to draw.
 *
 * Shared by the app-bar chip and the unlock splash so the two cannot quote
 * different numbers off the same payload — the splash exists precisely to say
 * what the chip will keep saying afterwards.
 */
export function summarizeQuota(page: QuotaPage | undefined): SourceQuotaSummary[] {
  const rows = page?.quota ?? [];
  if (!rows.length) return [];
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  return sources.map((source) => {
    const today = rows.find((r) => r.source === source && r.day === page!.today);
    // Rows are ordered day DESC by the API, so the first match is the most
    // recent day this source was seen on.
    const lastSeen = rows.find((r) => r.source === source)!;
    const limit = today?.limit_calls ?? lastSeen.limit_calls ?? ASSUMED_LIMIT;
    // No observation for today means nothing has been spent since the reset, so
    // the whole allowance is there. Stated as the full number rather than
    // "unknown": it is the honest reading, and a blank chip beside a Search
    // button is worse than a stale one.
    const remaining = today ? today.remaining : limit;
    const pct = Math.min(100, (remaining / limit) * 100);
    return {
      source,
      label: METERED_SOURCE_LABEL[source] ?? source,
      remaining,
      limit,
      today,
      lastSeen,
      pct,
      tone: pct < 10 ? "low" : pct < 25 ? "warn" : "ok",
    };
  });
}

/** The tooltip body, also reused as the splash's fine print. */
export function quotaDetailLines(s: SourceQuotaSummary, now: number): string[] {
  return [
    s.today
      ? `${s.today.remaining.toLocaleString()} of ${s.limit.toLocaleString()} calls left today · last seen ${sinceLabel(s.today.observed_at)}`
      : `No calls yet today. Last seen ${sinceLabel(s.lastSeen.observed_at)}, with ${s.lastSeen.remaining.toLocaleString()} left on ${s.lastSeen.day}.`,
    `Resets in ${quotaResetLabel(now)} (00:00 UTC).`,
  ];
}

// ---------------------------------------------------------------------------
// The other two meters: D1 rows read and written.
// ---------------------------------------------------------------------------
//
// Here rather than in a module of their own because all three chips share ONE
// tone scale and ONE clock. Both allowances reset at 00:00 UTC, so
// `quotaResetLabel` serves every chip, and a D1 meter at 8% left has to look
// exactly as alarmed as a seats.aero meter at 8% left or the cluster stops
// reading as one thing.
//
// They differ in what is observed. seats.aero states what is LEFT, in a header,
// on a call we made; Cloudflare states what has been SPENT, account-wide,
// several minutes ago. `summarizeD1Usage` does the subtraction so the chips can
// all count down, and `d1DetailLines` says out loud where the number came from.

/** The meter ids, which are display keys and nothing else — unlike
 *  `SEATSAERO_SOURCE_ID`, no database column holds either of these. */
export const D1_ROWS_READ_METER = "d1_rows_read";
export const D1_ROWS_WRITTEN_METER = "d1_rows_written";

const D1_METER_LABEL: Record<string, string> = {
  [D1_ROWS_READ_METER]: "D1 rows read",
  [D1_ROWS_WRITTEN_METER]: "D1 rows written",
};

function d1Meter(source: string, used: number, limit: number): QuotaSummary {
  // Going OVER the allowance is possible — the free plan starts refusing
  // queries, it does not roll the counter back — and a negative chip would be
  // the least useful thing to show at that moment. Clamped to 0, which reads as
  // "none left" and tones `error.main`.
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, (remaining / limit) * 100);
  return {
    source,
    label: D1_METER_LABEL[source] ?? source,
    remaining,
    limit,
    used,
    pct,
    tone: pct < 10 ? "low" : pct < 25 ? "warn" : "ok",
  };
}

/**
 * The two D1 meters, as the same shape the bolt chip renders.
 *
 * `[]` when `usage` is absent, which is every case where Cloudflare could not
 * be asked — no token configured, a timeout, a body that did not parse. The
 * chips then do not draw at all, which is the honest reading and the one the
 * seats.aero chip already takes when no source has ever reported. **A zeroed
 * meter would draw a full allowance**, and "we don't know" must never render as
 * "nothing to worry about"; the Worker never sends one, and this never invents
 * one.
 */
export function summarizeD1Usage(page: D1UsagePage | undefined): QuotaSummary[] {
  const u = page?.usage;
  if (!u) return [];
  return [
    d1Meter(D1_ROWS_READ_METER, u.rowsRead, u.readLimit),
    d1Meter(D1_ROWS_WRITTEN_METER, u.rowsWritten, u.writtenLimit),
  ];
}

/** The D1 tooltip body. Both caveats are load-bearing: the figure covers the
 *  whole Cloudflare account rather than this app, and it is minutes old — each
 *  would otherwise read as the chip being wrong. */
export function d1DetailLines(s: QuotaSummary, usage: D1Usage, now: number): string[] {
  return [
    `${s.remaining.toLocaleString()} of ${s.limit.toLocaleString()} left today · ${(s.used ?? 0).toLocaleString()} used · measured ${sinceLabel(usage.observedAt)}`,
    "Account-wide, from Cloudflare's own D1 analytics — it counts queries made outside this app too, and lags by a few minutes.",
    `Resets in ${quotaResetLabel(now)} (00:00 UTC).`,
  ];
}
