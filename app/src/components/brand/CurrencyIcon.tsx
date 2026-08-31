import { useState } from "react";
import { Box, Tooltip, alpha, useTheme } from "@mui/material";
import { readable } from "../../theme/build";
import {
  CURRENCY_COLOR,
  CURRENCY_DOMAIN,
  CURRENCY_LABEL,
  faviconUrl,
  NEUTRAL_COLOR,
  resolveColor,
} from "../../lib/currencies";

/**
 * A transfer currency as its issuer's mark — the one shape every "who can book
 * this" surface uses.
 *
 * It replaced a text chip, and the lost name is what that cost: a row of chips
 * reading Chase / Cap One / Bilt / Citi / Amex was among the widest cells in a
 * finds row and the least varied, but a card you recognize by its logo needs no
 * word beside it. So **the tooltip is the label, not decoration** — it is built in
 * here rather than left to callers, because an unnamed mark in a row that never
 * spells the name out is unreadable to anyone who doesn't already know it.
 *
 * The footprint is fixed whether the favicon resolves or not — the fallback dot
 * centres inside the same square — so a column of these stays aligned instead
 * of jittering row to row.
 */
export function CurrencyIcon({
  code,
  size = 22,
  note,
}: {
  code: string;
  size?: number;
  /** Extra clause for the tooltip, e.g. a filter's meaning or a transfer ratio.
   *  It joins the name rather than replacing it, and it is why callers don't wrap
   *  these in a Tooltip of their own — nested tooltips fire together. */
  note?: string;
}) {
  const [broken, setBroken] = useState(false);
  const theme = useTheme();
  const name = CURRENCY_LABEL[code] ?? code;
  const label = note ? `${name} — ${note}` : name;
  const color = readable(
    resolveColor(CURRENCY_COLOR[code] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
    theme,
  );
  const domain = CURRENCY_DOMAIN[code];
  const showIcon = Boolean(domain) && !broken;
  return (
    <Tooltip title={label}>
      {/* `role="img"` so the name survives for a screen reader too: without it
          the label lives only in a hover tooltip, and the cell announces as an
          empty div. */}
      <Box
        role="img"
        aria-label={label}
        sx={{
          width: size,
          height: size,
          borderRadius: `${Math.round(size * 0.26)}px`,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          // Issuer favicons are drawn for white backgrounds, so the tile stays
          // white in every theme — it is the mark's own paper, not a surface of
          // ours. Only its edge follows the theme, which is what keeps a white
          // tile from dissolving into a light theme's near-white page.
          bgcolor: showIcon ? "#ffffff" : "transparent",
          border: showIcon ? `1px solid ${theme.palette.divider}` : "none",
        }}
      >
        {showIcon ? (
          <Box
            component="img"
            src={faviconUrl(domain!)}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            sx={{ width: size * 0.7, height: size * 0.7, objectFit: "contain" }}
          />
        ) : (
          <Box
            sx={{
              width: size * 0.45,
              height: size * 0.45,
              borderRadius: "50%",
              bgcolor: color,
              boxShadow: `0 0 ${size * 0.36}px ${alpha(color, 0.7)}`,
            }}
          />
        )}
      </Box>
    </Tooltip>
  );
}