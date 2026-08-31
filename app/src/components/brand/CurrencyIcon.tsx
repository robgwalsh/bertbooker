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
 */
export function CurrencyIcon({
  code,
  size = 22,
  note,
}: {
  code: string;
  size?: number;
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