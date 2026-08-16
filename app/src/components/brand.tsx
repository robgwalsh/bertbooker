// The marks: the four small components that make a dense row scannable without
// spelling anything out. An issuer's logo for a transfer currency, a carrier's
// logo for a flight, and the cabin chip.
//
// They share one non-obvious rule, which is why they sit together: **a fixed
// footprint whether the image resolves or not.** These render in columns, and a
// mark that collapses to nothing on a failed load makes every row below it jump.
// The fallback always occupies the same square.
//
// They share a second: issuer and carrier tiles are drawn for WHITE backgrounds,
// so the tile keeps its own paper in every theme — it is the mark's ground, not
// a surface of ours. Only the edge follows the palette, which is what stops a
// white tile dissolving into a light theme's near-white page.

import { useState } from "react";
import { Box, Chip, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import { readable } from "../theme/build";
import {
  CABIN_COLOR,
  CURRENCY_COLOR,
  CURRENCY_DOMAIN,
  CURRENCY_LABEL,
  faviconUrl,
  NEUTRAL_COLOR,
  resolveColor,
  sortCurrencies,
} from "../lib/currencies";
import { airlineLogoUrl } from "../lib/flights";

/**
 * A transfer currency as its issuer's mark — the one shape every "who can book
 * this" surface uses.
 *
 * It replaced a text chip, and the lost name is what that cost: four chips
 * reading Chase / Cap One / Bilt / Citi were among the widest cells in a finds
 * row and the least varied, but a card you recognize by its logo needs no word
 * beside it. So **the tooltip is the label, not decoration** — it is built in
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

/**
 * A carrier's logo, sized to sit inline to the left of a flight code.
 *
 * The footprint is fixed whether or not the image resolves, so flight numbers
 * stay aligned down the column instead of jittering row to row.
 */
export function AirlineLogo({ code, size = 18 }: { code?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const theme = useTheme();
  const carrier = code && /^[A-Z0-9]{2}$/i.test(code) ? code.toUpperCase() : undefined;
  const showIcon = Boolean(carrier) && !broken;
  return (
    <Box
      title={carrier}
      sx={{
        width: size,
        height: size,
        borderRadius: 0.75,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        // The tiles are drawn on white, so they keep their paper (see
        // `CurrencyIcon`); the fallback square and every edge follow the theme.
        bgcolor: showIcon ? "#ffffff" : alpha(theme.palette.text.secondary, 0.14),
        border: `1px solid ${theme.palette.divider}`,
      }}
    >
      {showIcon ? (
        <Box
          component="img"
          src={airlineLogoUrl(carrier!)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          sx={{ width: size, height: size, objectFit: "contain" }}
        />
      ) : (
        <FlightRoundedIcon sx={{ fontSize: size * 0.62, color: "text.disabled" }} />
      )}
    </Box>
  );
}

export function CabinChip({ cabin }: { cabin: string }) {
  const theme = useTheme();
  const color = readable(
    resolveColor(CABIN_COLOR[cabin] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
    theme,
  );
  return (
    <Chip
      size="small"
      label={cabin}
      sx={{
        textTransform: "capitalize",
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    />
  );
}

/**
 * Which currencies can book this, as issuer marks.
 *
 * Takes the raw `transfer_currencies` blob rather than a parsed list because
 * every caller has it in that form, and a malformed one renders an em-dash
 * rather than throwing — "we don't know who can book it" is a legitimate cell.
 */
export function BookableCurrencies({
  json,
  size,
  note,
}: {
  json?: string;
  size?: number;
  note?: string;
}) {
  let codes: string[] = [];
  try {
    codes = json ? (JSON.parse(json) as string[]) : [];
  } catch {
    codes = [];
  }
  if (codes.length === 0)
    return (
      <Typography component="span" color="text.disabled">
        —
      </Typography>
    );
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {sortCurrencies(codes).map((c) => (
        <CurrencyIcon key={c} code={c} size={size} note={note} />
      ))}
    </Stack>
  );
}
