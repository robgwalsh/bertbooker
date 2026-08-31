import { useEffect, useMemo } from "react";
import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { CircleMarker, MapContainer, Polygon, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RouteGraphEdge } from "../../../api/index";
import { leafletStyles } from "../../../theme/leafletChrome";
import { graphBounds, graphEndpoints, graphLines } from "../../../lib/routeGraph";
import {
  basemapRings,
  BORDER,
  COAST,
  LAND_FILL,
  ROUTE_COLOR,
  WATER,
} from "../../../lib/routeMapGeometry";
import { tint } from "../../../theme/build";
import { MAX_DRAWN_LINES } from "./filters";

/**
 * A program's route network, drawn as arcs.
 *
 * **This map renders on a canvas, not in SVG**, and that is not a preference.
 * A measured graph is ~8,300 pairs; that many SVG `<path>` nodes makes panning
 * unusable, while one canvas surface stays smooth. `preferCanvas` on the
 * container is what routes every vector through it — the basemap below included.
 *
 * **There are no tiles here.** The sibling `AirportMap` is a raster basemap and
 * has to ask CARTO for a light or dark map because nothing downstream can
 * recolour a PNG. This one is drawn from the same vector geometry the trip
 * list's `RouteMap` uses, in the same green land over blue water, which is the
 * only way a map in this app gets to choose its own cartography at all.
 *
 * The sibling `AirportMap` clusters POINTS with Supercluster. Nothing here does,
 * because an arc has two ends and clustering it would draw lines to places the
 * program does not fly. Capping and saying so is the honest equivalent.
 */
export function RouteGraphMap({
  edges,
  total,
  truncated,
  loading,
  fitKey,
}: {
  edges: RouteGraphEdge[];
  total: number;
  truncated: boolean;
  loading: boolean;
  /** Changes when the search changes; the view refits only then, so panning is
   *  not undone by a background refetch. */
  fitKey: string;
}) {
  const theme = useTheme();
  const { lines, pairs, unplottable, omitted } = useMemo(
    () => graphLines(edges, MAX_DRAWN_LINES),
    [edges],
  );
  const endpoints = useMemo(() => graphEndpoints(lines), [lines]);
  const bounds = useMemo(() => graphBounds(lines), [lines]);

  return (
    <>
      {leafletStyles(theme)}
      <Stack
        direction="row"
        sx={{ alignItems: "baseline", justifyContent: "space-between", mb: 1, gap: 2 }}
      >
        <Typography variant="body2" color="text.secondary">
          {caption({ drawn: lines.length, pairs, total, truncated, omitted, unplottable })}
        </Typography>
        {loading && <CircularProgress size={14} />}
      </Stack>

      <Box
        sx={{
          height: { xs: 320, sm: 420 },
          border: (t) => `1px solid ${tint(t, 0.08)}`,
          position: "relative",
          // The ocean. Stated here rather than in `leafletStyles` because that
          // one is shared with the tiled Airports map, which must keep painting
          // the theme's own ground under its PNGs. More specific than the global
          // rule by one class, so it wins.
          "& .leaflet-container": { height: "100%", width: "100%", background: WATER },
        }}
      >
        <MapContainer
          center={[20, 0]}
          zoom={2}
          minZoom={2}
          worldCopyJump
          // Every vector on one canvas surface — see the note above.
          preferCanvas
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <Basemap />

          {lines.map((line) => (
            <Polyline
              key={`${line.origin}>${line.destination}`}
              positions={[line.from, line.to]}
              pathOptions={{
                // The trip list's route colour, not the theme's accent. The
                // ground under it is fixed cartography now, so the ink over it
                // has to be fixed too — a theme whose accent is a deep blue
                // would sink into the ocean.
                color: ROUTE_COLOR,
                weight: line.bidirectional ? 1.1 : 0.8,
                opacity: line.bidirectional ? 0.6 : 0.35,
              }}
            />
          ))}

          {endpoints.map((e) => (
            <CircleMarker
              key={e.code}
              center={e.at}
              radius={2.5}
              pathOptions={{
                color: ROUTE_COLOR,
                fillColor: ROUTE_COLOR,
                fillOpacity: 0.9,
                weight: 0,
              }}
            >
              <Popup>
                <Typography variant="body2">{e.code}</Typography>
              </Popup>
            </CircleMarker>
          ))}

          <FitToGraph bounds={bounds} fitKey={fitKey} />
        </MapContainer>

        {!loading && !lines.length && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
              // Fixed, like everything else laid over the basemap: the theme's
              // `text.secondary` is near-black under a light theme and would be
              // unreadable over the ocean.
              bgcolor: alpha("#000000", 0.45),
            }}
          >
            <Typography variant="body2" sx={{ color: alpha("#ffffff", 0.85) }}>
              Nothing to draw.
            </Typography>
          </Box>
        )}
      </Box>
    </>
  );
}

/**
 * Which copies of the world the basemap is drawn in.
 *
 * One either side is enough: the map cannot zoom out past 2, where a little over
 * one world fits across the widest pane this sits in, and `worldCopyJump`
 * re-centres a pan that runs past the antimeridian before a third copy could
 * come into view.
 */
const WORLD_COPIES = [-360, 0, 360];

/**
 * Land, lakes and borders, drawn as vectors on the same canvas as the arcs.
 *
 * Three layers and three Leaflet paths — not three hundred. Each `Polygon` takes
 * every ring of its layer at once, which the canvas renderer walks into a single
 * path and fills once; a component per ring would be ~1,350 layers for the
 * decorative half of the picture.
 *
 * `fillRule: "nonzero"` rather than Leaflet's `evenodd` default: the rings of a
 * layer are separate landmasses, not a shape with holes, and Natural Earth does
 * not promise they are all wound the same way. Lakes are painted back over the
 * land as water for the same reason `RouteMap` does it — they are what makes a
 * domestic route read as being somewhere.
 *
 * `interactive: false` matters more than it looks: without it Leaflet hit-tests
 * every one of these vertices on every mouse move, and the only thing on this
 * map worth clicking is an airport.
 */
function Basemap() {
  const { land, lakes, borders } = useMemo(() => basemapRings(WORLD_COPIES), []);

  return (
    <>
      <Polygon
        positions={land}
        pathOptions={{
          interactive: false,
          fillRule: "nonzero",
          fillColor: LAND_FILL,
          fillOpacity: 1,
          color: COAST,
          weight: 0.5,
        }}
      />
      <Polygon
        positions={lakes}
        pathOptions={{
          interactive: false,
          fillRule: "nonzero",
          fillColor: WATER,
          fillOpacity: 1,
          color: COAST,
          weight: 0.4,
        }}
      />
      <Polyline
        positions={borders}
        pathOptions={{
          interactive: false,
          fill: false,
          color: BORDER,
          opacity: 0.22,
          weight: 0.5,
        }}
      />
    </>
  );
}

/** Say what is on screen and what is not. A graph drawn short reads as a program
 *  that flies fewer places, so every omission is named rather than implied. */
function caption(o: {
  drawn: number;
  pairs: number;
  total: number;
  truncated: boolean;
  omitted: number;
  unplottable: number;
}): string {
  if (!o.total) return "No routes.";
  // Counted in PAIRS, not directed routes: a pair flown both ways is one line,
  // so "n of <edge count>" would never add up against `omitted`. The directed
  // total is stated separately rather than silently conflated with it.
  const parts = [
    o.omitted
      ? `${o.drawn.toLocaleString()} of ${o.pairs.toLocaleString()} city pairs drawn`
      : `${o.drawn.toLocaleString()} city pairs`,
    `${o.total.toLocaleString()} directed routes`,
  ];
  if (o.omitted) parts.push(`${o.omitted.toLocaleString()} over the draw cap`);
  if (o.truncated) parts.push("more matched than were fetched");
  if (o.unplottable) parts.push(`${o.unplottable.toLocaleString()} with an unknown airport`);
  return parts.join(" · ");
}

/** Refit only when the search identity changes — a background refetch must not
 *  yank the view out from under someone who has panned. */
function FitToGraph({
  bounds,
  fitKey,
}: {
  bounds: [[number, number], [number, number]] | null;
  fitKey: string;
}) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], animate: false });
    // Deliberately keyed on `fitKey` alone: `bounds` changes identity on every
    // refetch even when the set is the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  return null;
}
