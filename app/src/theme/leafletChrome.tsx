import { GlobalStyles } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { tint } from "./build";

/**
 * What a Leaflet map in this app needs beyond its own data, in one place.
 *
 * There are two of them — the Airports pane's clustered points and the
 * seats.aero pane's route graph — and both need the same restatement of the
 * palette for Leaflet's own chrome. Shared rather than copied because the
 * failure mode of a copy is silent: one map keeps working when a theme token
 * moves, and the other opens a black popup over a white basemap.
 *
 * **Only `leafletStyles` is shared; the tiles are the Airports map's alone.**
 * The route graph draws a vector basemap from `lib/routeMapGeometry.ts` instead,
 * which is what lets it pick its own green-and-blue cartography — a raster tile
 * is a PNG and nothing downstream can recolour it.
 *
 * Lives in `components/` by that directory's own rule — presentation used by
 * more than one page.
 */

/**
 * Leaflet's own chrome — popups, zoom controls, attribution — repainted in the
 * app's theme.
 *
 * Leaflet ships its own stylesheet and knows nothing about MUI, so this is the
 * one place in the app that has to restate the palette as plain CSS. It reads
 * the live theme rather than the near-black it was written against, which is
 * what stops a light theme from opening a black popup over a white map.
 */
export const leafletStyles = (theme: Theme) => (
  <GlobalStyles
    styles={{
      ".leaflet-container": {
        background: theme.palette.background.default,
        fontFamily: "inherit",
      },
      ".leaflet-popup-content-wrapper, .leaflet-popup-tip": {
        background: theme.palette.background.paper,
        color: theme.palette.text.primary,
        boxShadow: `0 8px 30px ${alpha("#000000", theme.palette.mode === "dark" ? 0.5 : 0.18)}`,
      },
      ".leaflet-popup-content": { margin: "12px 14px" },
      ".leaflet-container a.leaflet-popup-close-button": {
        color: theme.palette.text.secondary,
      },
      ".leaflet-bar a": {
        background: theme.palette.background.paper,
        color: theme.palette.text.primary,
        borderColor: theme.palette.divider,
      },
      ".leaflet-bar a:hover": { background: tint(theme, 0.08) },
      ".leaflet-control-attribution": {
        background: alpha(theme.palette.background.default, 0.7),
        color: theme.palette.text.secondary,
      },
      ".leaflet-control-attribution a": { color: theme.palette.secondary.main },
    }}
  />
);

/**
 * CARTO's basemap, in the theme's polarity. **The Airports map only.**
 *
 * The tiles are raster images — nothing downstream can recolour them — so a
 * light theme has to ask the tile server for a different map rather than restyle
 * the one it got. This is the whole reason that map cares about `mode` at all,
 * and why its `TileLayer` is keyed on it: Leaflet caches the URL template, so
 * only a re-mount picks up the swap.
 *
 * It is also the reason the route graph does not use these: it wanted a specific
 * cartography (green land, blue water) and a tile server either serves that or
 * it does not.
 */
export const TILE_URL: Record<"dark" | "light", string> = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
