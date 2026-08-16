import { useQuery } from "@tanstack/react-query";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import { api } from "../api";
// The numbers behind this chip live in `lib/quota.ts` — pure, and therefore
// testable, which a `.tsx` file cannot be under the `*.test.ts` glob.
import {
  quotaDetailLines,
  quotaToneColor,
  QUOTA_CHIP_ID,
  summarizeQuota,
} from "../lib/quota";

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
