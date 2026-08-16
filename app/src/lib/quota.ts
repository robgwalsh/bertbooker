// The metered allowance as numbers, with no chip around them.
//
// Split out of `components/QuotaIndicator.tsx` so it is reachable: the vitest
// glob is `*.test.ts` only, and a `.test.tsx` is not skipped — it is never
// collected at all, silently, with a green run. Anything pure that wants a test
// has to live in a `.ts` file, which is the rule `lib/` exists to state.
//
// `quotaToneColor` takes a MUI `Theme` but imports it as a type only, so this
// module stays Node-testable with no DOM.

import { SEATSAERO_SOURCE_ID, type QuotaPage, type SourceQuota } from "../api";
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

/** One metered source's allowance, reduced to what a display needs. */
export interface QuotaSummary {
  source: string;
  label: string;
  /** What's left today — the *observed* number when there is one, otherwise the
   *  whole allowance. See the note in `summarizeQuota`. */
  remaining: number;
  limit: number;
  /** Today's row, absent when nothing has been spent since the reset. */
  today?: SourceQuota;
  /** The most recent observation on any day. */
  lastSeen: SourceQuota;
  /** 0–100, for a meter. */
  pct: number;
  /**
   * How alarmed to look.
   *
   * A tone rather than a colour, because `summarizeQuota` is a pure function of
   * the payload and has no theme to read — and a hardcoded traffic light stayed
   * the old near-black theme's coral and amber under every other palette. Both
   * consumers turn it into a colour with `quotaToneColor`.
   */
  tone: QuotaTone;
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
export function summarizeQuota(page: QuotaPage | undefined): QuotaSummary[] {
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
export function quotaDetailLines(s: QuotaSummary, now: number): string[] {
  return [
    s.today
      ? `${s.today.remaining.toLocaleString()} of ${s.limit.toLocaleString()} calls left today · last seen ${sinceLabel(s.today.observed_at)}`
      : `No calls yet today. Last seen ${sinceLabel(s.lastSeen.observed_at)}, with ${s.lastSeen.remaining.toLocaleString()} left on ${s.lastSeen.day}.`,
    `Resets in ${quotaResetLabel(now)} (00:00 UTC).`,
  ];
}
