import { alpha, Box, useTheme } from "@mui/material";
import { useState } from "react";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";

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

/** Square carrier logo by IATA code, from Kiwi's public image CDN.
 *
 *  Keyed on the code the segment already carries, so — unlike a hand-maintained
 *  domain→favicon map — a regional operator flying a single leg (Envoy, SkyWest,
 *  Republic) still gets a real mark. Unknown codes redirect to a generic plane
 *  tile rather than 404ing, so onError is a backstop for network failure rather
 *  than the normal miss path. */
const airlineLogoUrl = (iata: string) => `https://images.kiwi.com/airlines/64x64/${iata}.png`;