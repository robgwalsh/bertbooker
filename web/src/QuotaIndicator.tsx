import { useQuery } from "@tanstack/react-query";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import { api, type QuotaPage, type SourceQuota } from "./api";
import { sinceLabel } from "./ui";

/** Display names for metered source ids. The id itself is a permanent database
 *  value; this is just what a human should read. */
const METERED_SOURCE_LABEL: Record<string, string> = {
  "api:seatsaero": "seats.aero Partner API",
};

/** Assumed daily ceiling when the vendor's response didn't state one. Only used
 *  to draw the meter — never to fill in a `remaining` we didn't observe. */
const ASSUMED_LIMIT = 1000;

/** The metered source the app actually spends. `QuotaSplash` leads with this one
 *  when several have reported. */
export const PRIMARY_METERED_SOURCE = "api:seatsaero";

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

/**
 * What's left of each metered source's daily API allowance, as a chip in the
 * title bar.
 *
 * It sits in the app bar rather than on a page because the allowance is not a
 * property of any one screen — Search spends it from the Routes page and every
 * enrich icon in the finds table spends it too — and because a number you have
 * to scroll to is a number you check after the fact. At a glance it is
 * `n/1000`; the tooltip carries the rest, which is the part you only want when
 * something looks wrong.
 *
 * Reads D1, not whoever made the call. The vendor's rate-limit header is only
 * visible to the process that made the request, but once written down the number
 * is readable afterwards, from a phone, with nothing running locally.
 *
 * **This displays and does not enforce.** Nothing here or downstream refuses a
 * search when the meter is low — see the `source_quota` note in
 * migrations/0001_init.sql.
 * Code that gates a call on this number is the deleted budget guard returning.
 */
export function QuotaIndicator() {
  const q = useQuery({
    queryKey: ["quota"],
    queryFn: api.quota,
    refetchInterval: 60_000,
  });

  const theme = useTheme();
  const summaries = summarizeQuota(q.data);
  if (!summaries.length) return null; // no metered source has ever reported — say nothing

  const now = Date.now();

  return (
    // The id rides the wrapper, not one chip: it is the landing zone the unlock
    // splash flies into, and that is this whole cluster.
    <Stack id={QUOTA_CHIP_ID} direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {summaries.map((s) => {
        const color = quotaToneColor(s.tone, theme);
        return (
          <Tooltip
            key={s.source}
          title={
            <Box sx={{ py: 0.5 }}>
              <Typography variant="caption" component="div" sx={{ fontWeight: 700 }}>
                {s.label}
              </Typography>
              {quotaDetailLines(s, now).map((line) => (
                <Typography key={line} variant="caption" component="div">
                  {line}
                </Typography>
              ))}
              <Typography variant="caption" component="div" sx={{ opacity: 0.75, mt: 0.5 }}>
                Previously fetched data is staill available while seats.aero quota is exhausted
              </Typography>
            </Box>
          }
        >
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              alignItems: "center",
              px: 1,
              py: 0.3,
              // Square, like the rest of the chrome — see `buildTheme`.
              borderRadius: 0.75,
              cursor: "help",
              color,
              bgcolor: alpha(color, 0.12),
              border: `1px solid ${alpha(color, 0.3)}`,
            }}
          >
            <BoltRoundedIcon sx={{ fontSize: 14 }} />
            <Typography
              variant="caption"
              sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
            >
              {s.remaining.toLocaleString()}/{s.limit.toLocaleString()}
            </Typography>
          </Stack>
          </Tooltip>
        );
      })}
    </Stack>
  );
}
