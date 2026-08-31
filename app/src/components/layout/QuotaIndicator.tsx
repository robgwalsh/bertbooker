import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import { api } from "../../api";
import {
  D1_ROWS_READ_METER,
  quotaDetailLines,
  d1DetailLines,
  quotaToneColor,
  QUOTA_CHIP_ID,
  summarizeD1Usage,
  summarizeQuota,
} from "../../lib/quota";
import { compactCount } from "../../lib/format";

function MeterChip({
  icon,
  color,
  text,
  tooltip,
}: {
  icon: ReactNode;
  color: string;
  text: string;
  tooltip: ReactNode;
}) {
  return (
    <Tooltip title={tooltip}>
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
        {icon}
        <Typography variant="caption" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {text}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

/** The tooltip body every chip uses: a bold label over a stack of lines. */
function MeterTooltip({
  label,
  lines,
  footer,
}: {
  label: string;
  lines: string[];
  footer?: string;
}) {
  return (
    <Box sx={{ py: 0.5 }}>
      <Typography variant="caption" component="div" sx={{ fontWeight: 700 }}>
        {label}
      </Typography>
      {lines.map((line) => (
        <Typography key={line} variant="caption" component="div">
          {line}
        </Typography>
      ))}
      {footer && (
        <Typography variant="caption" component="div" sx={{ opacity: 0.75, mt: 0.5 }}>
          {footer}
        </Typography>
      )}
    </Box>
  );
}

/**
 * What is left of today's three daily allowances, as chips in the title bar.
 */
export function QuotaIndicator() {
  const q = useQuery({
    queryKey: ["quota"],
    queryFn: api.quota,
    refetchInterval: 60_000,
  });
  const d1 = useQuery({
    queryKey: ["d1-usage"],
    queryFn: api.d1Usage,
    // Cloudflare's analytics lag by minutes and the Worker caches for five, so
    // a faster poll would only re-serve the same numbers.
    refetchInterval: 300_000,
  });

  const theme = useTheme();
  const summaries = summarizeQuota(q.data);
  const d1Summaries = summarizeD1Usage(d1.data);
  const d1Observed = d1.data?.usage;
  // Nothing has ever reported — say nothing rather than draw an empty frame.
  if (!summaries.length && !d1Summaries.length) return null;

  const now = Date.now();
  return (
    <Stack id={QUOTA_CHIP_ID} direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {summaries.map((s) => (
        <MeterChip
          key={s.source}
          icon={<BoltRoundedIcon sx={{ fontSize: 14 }} />}
          color={quotaToneColor(s.tone, theme)}
          text={`${s.remaining.toLocaleString()}/${s.limit.toLocaleString()}`}
          tooltip={
            <MeterTooltip
              label={s.label}
              lines={quotaDetailLines(s, now)}
              footer="Previously fetched data is still available while seats.aero quota is exhausted"
            />
          }
        />
      ))}
      {d1Observed &&
        d1Summaries.map((s) => (
          <MeterChip
            key={s.source}
            icon={
              s.source === D1_ROWS_READ_METER ? (
                <ArrowDownwardRoundedIcon sx={{ fontSize: 14 }} />
              ) : (
                <ArrowUpwardRoundedIcon sx={{ fontSize: 14 }} />
              )
            }
            color={quotaToneColor(s.tone, theme)}
            // Compact, unlike the bolt chip: `3,762,148/5,000,000` is nineteen
            // characters of a toolbar that already carries four tabs.
            text={`${compactCount(s.remaining)}/${compactCount(s.limit)}`}
            tooltip={
              <MeterTooltip
                label={s.label}
                lines={d1DetailLines(s, d1Observed, now)}
              />
            }
          />
        ))}
    </Stack>
  );
}
