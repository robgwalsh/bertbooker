import { useState } from "react";
import { Box, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { faviconUrl } from "../../lib/currencies";
import { monogram, PROGRAM_DOMAIN, tileColor } from "./brands";
import type { ProgramInfo } from "../../api";

// A single square brand tile: real favicon on a light chip, monogram fallback
// when there's no known domain or the icon fails to load.
export function BrandTile({
  name,
  domain,
  color,
  size = 46,
}: {
  name: string;
  domain?: string;
  color: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const showIcon = Boolean(domain) && !broken;
  const img = Math.round(size * 0.6);
  return (
    <Box
      title={name}
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        // The favicon keeps its white paper in every theme (see `CurrencyIcon`);
        // only the edge follows, so a white tile doesn't dissolve into a light
        // theme's near-white page.
        bgcolor: showIcon ? "#ffffff" : alpha(color, 0.18),
        border: (t) =>
          `1px solid ${showIcon ? t.palette.divider : alpha(color, 0.4)}`,
        color,
        fontWeight: 700,
        fontSize: Math.round(size * 0.32),
        letterSpacing: "0.02em",
      }}
    >
      {showIcon ? (
        <Box
          component="img"
          src={faviconUrl(domain!)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          sx={{ width: img, height: img, objectFit: "contain" }}
        />
      ) : (
        monogram(name)
      )}
    </Box>
  );
}

export function ProgramTile({ program, size }: { program: ProgramInfo; size?: number }) {
  const theme = useTheme();
  return (
    <BrandTile
      name={program.name}
      domain={PROGRAM_DOMAIN[program.code]}
      color={tileColor(program, theme)}
      size={size}
    />
  );
}

// Arrange tiles so the bounding box is as square as possible: ceil(sqrt(n)) cols.
export function ProgramTileGrid({ programs }: { programs: ProgramInfo[] }) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(programs.length)));
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, auto)`,
        gap: 0.75,
        p: 0.25,
      }}
    >
      {programs.map((p) => (
        <ProgramTile key={p.code} program={p} />
      ))}
    </Box>
  );
}
