import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Chip,
  CircularProgress,
  GlobalStyles,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import Supercluster from "supercluster";
import "leaflet/dist/leaflet.css";
import type { AirportGeo } from "../../../api";
import { countryName, flagEmoji } from "../../../lib/format";
import { TYPE_LABEL } from "../../../lib/airportTypes";
import { tint } from "../../../theme/build";
import {
  TILE_ATTRIBUTION,
  TILE_URL,
  leafletStyles,
} from "../../../components/leafletChrome";

// One airport carried as a supercluster point's properties.
type AirportProps = { airport: AirportGeo };
// A viewport feature is either an aggregated cluster or a single airport point.
type Feature = ReturnType<Supercluster<AirportProps>["getClusters"]>[number];

// Small colored dot for a single airport (no image assets → no Leaflet icon-path bug).
//
// Leaflet icons are HTML STRINGS, so `sx` and the theme can't reach them — every
// colour has to be threaded in by the caller. That is the only reason these take
// a `fallback` and an `accent` rather than reading a module constant.
function dotIcon(type: string, fallback: string): L.DivIcon {
  const color = TYPE_LABEL[type]?.color ?? fallback;
  return L.divIcon({
    className: "",
    iconSize: [10, 10],
    html: `<span style="display:block;width:10px;height:10px;border-radius:50%;background:${color};border:1px solid rgba(0,0,0,0.55);box-shadow:0 0 5px ${color}88"></span>`,
  });
}

// Sized/counted bubble for a cluster; grows with the number of points inside.
//
// Nearly opaque, with the count in the accent's own contrast text: the bubble
// has to be legible over BOTH tile polarities and over whatever coastline it
// lands on, and a translucent wash that worked over one dark basemap turns the
// number to mush over a light one.
function clusterIcon(
  count: number,
  label: string,
  accent: string,
  labelColor: string,
): L.DivIcon {
  const size = count < 100 ? 34 : count < 1000 ? 42 : 52;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    html: `<div style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${alpha(accent, 0.85)};border:1px solid ${alpha(accent, 0.95)};color:${labelColor};font-size:12px;font-weight:700">${label}</div>`,
  });
}

// Renders the airports for the current viewport, re-querying supercluster on pan/zoom
// so only a few hundred markers ever exist in the DOM (not all ~72k points).
function ClusterLayer({ index }: { index: Supercluster<AirportProps> }) {
  const map = useMap();
  const theme = useTheme();
  const fallbackColor = theme.palette.text.secondary;
  const [features, setFeatures] = useState<Feature[]>([]);

  const update = useCallback(() => {
    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];
    setFeatures(index.getClusters(bbox, Math.round(map.getZoom())));
  }, [map, index]);

  useMapEvents({ moveend: update, zoomend: update });
  useEffect(update, [update]);

  return (
    <>
      {features.map((f) => {
        const [lng, lat] = f.geometry.coordinates as [number, number];
        const props = f.properties;

        if ("cluster" in props) {
          const clusterId = props.cluster_id;
          return (
            <Marker
              key={`c-${clusterId}`}
              position={[lat, lng]}
              icon={clusterIcon(
                props.point_count,
                String(props.point_count_abbreviated),
                theme.palette.primary.main,
                theme.palette.getContrastText(theme.palette.primary.main),
              )}
              eventHandlers={{
                click: () =>
                  map.setView([lat, lng], index.getClusterExpansionZoom(clusterId)),
              }}
            />
          );
        }

        const a = props.airport;
        const t = TYPE_LABEL[a.type];
        return (
          <Marker key={a.ident} position={[lat, lng]} icon={dotIcon(a.type, fallbackColor)}>
            <Popup>
              <Stack spacing={0.5} sx={{ minWidth: 170 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  {a.iata ? (
                    <Chip
                      size="small"
                      label={a.iata}
                      sx={{
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        color: "secondary.main",
                        bgcolor: (th) => th.spec.accentMuted,
                      }}
                    />
                  ) : null}
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {a.name}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {a.city ? `${a.city} · ` : ""}
                  {flagEmoji(a.country)} {countryName(a.country) || a.country || ""}
                </Typography>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                  <Box
                    component="span"
                    sx={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      bgcolor: t?.color ?? fallbackColor,
                    }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {t?.label ?? a.type.replace(/_/g, " ")}
                  </Typography>
                </Stack>
              </Stack>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

// Frames the map on whatever the current search matched. `fitKey` is the search
// identity (not the row count), so re-running the same search doesn't yank a map
// the user has panned, but changing the criteria re-frames it. A null key means
// "leave the view alone" — that's the unfiltered world view.
function FitToResults({ airports, fitKey }: { airports: AirportGeo[]; fitKey: string | null }) {
  const map = useMap();

  useEffect(() => {
    if (fitKey === null || !airports.length) return;
    const bounds = L.latLngBounds(airports.map((a) => [a.latitude, a.longitude]));
    // A single match has zero-area bounds; cap the zoom so it doesn't slam to max.
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);

  return null;
}

// Legend mapping the dot colors to airport types — only the types actually
// present in the current results, so a filtered search doesn't show dead keys.
function Legend({ types }: { types: Set<string> }) {
  const entries = Object.entries(TYPE_LABEL).filter(([type]) => types.has(type));
  if (!entries.length) return null;

  return (
    <Paper
      elevation={0}
      sx={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 1000,
        px: 1.5,
        py: 1,
        bgcolor: (t) => alpha(t.palette.background.paper, 0.85),
        border: (t) => `1px solid ${tint(t, 0.08)}`,
        backdropFilter: "blur(4px)",
      }}
    >
      <Stack spacing={0.5}>
        {entries.map(([type, { label, color }]) => (
          <Stack key={type} direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: color }} />
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}


/**
 * Plots a set of airports, clustered client-side. Purely presentational — the
 * caller owns the query, so the map always shows exactly what the current
 * search matched.
 */
export function AirportMap({
  airports,
  fitKey,
  loading = false,
  height = 420,
}: {
  airports: AirportGeo[];
  /**
   * Search identity; changing it re-frames the map on the new results. Pass null
   * to leave the viewport untouched (e.g. the default, unsearched world view).
   */
  fitKey: string | null;
  loading?: boolean;
  height?: number | string;
}) {
  // Rebuild the supercluster index whenever the matched set changes.
  const index = useMemo(() => {
    const sc = new Supercluster<AirportProps>({ radius: 60, maxZoom: 16 });
    sc.load(
      airports.map((a) => ({
        type: "Feature" as const,
        properties: { airport: a },
        geometry: { type: "Point" as const, coordinates: [a.longitude, a.latitude] },
      })),
    );
    return sc;
  }, [airports]);

  const presentTypes = useMemo(() => new Set(airports.map((a) => a.type)), [airports]);
  const theme = useTheme();

  return (
    <>
      {leafletStyles(theme)}
      <Box
        component={Paper}
        elevation={0}
        sx={{
          position: "relative",
          overflow: "hidden",
          height,
          border: (t) => `1px solid ${tint(t, 0.08)}`,
        }}
      >
        <Legend types={presentTypes} />

        {/* Non-blocking spinner: the previous result set stays plotted while the
            next search is in flight, so the map doesn't flash empty on keystrokes. */}
        {loading ? (
          <Box
            sx={{
              position: "absolute",
              top: 12,
              left: 12,
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1.25,
              py: 0.75,
              borderRadius: 1,
              bgcolor: (t) => alpha(t.palette.background.paper, 0.85),
              border: (t) => `1px solid ${tint(t, 0.08)}`,
            }}
          >
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              Loading…
            </Typography>
          </Box>
        ) : null}

        {!loading && airports.length === 0 ? (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <Typography variant="body2" color="text.secondary">
              No airports match your search.
            </Typography>
          </Box>
        ) : null}

        <MapContainer
          center={[25, 5]}
          zoom={2}
          minZoom={2}
          worldCopyJump
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            // Keyed so switching themes swaps the tiles instead of restyling
            // them in place — Leaflet caches a layer's URL template, and without
            // a new key the old polarity stays on screen until a pan.
            key={theme.palette.mode}
            url={TILE_URL[theme.palette.mode]}
            attribution={TILE_ATTRIBUTION}
          />
          <ClusterLayer index={index} />
          <FitToResults airports={airports} fitKey={fitKey} />
        </MapContainer>
      </Box>
    </>
  );
}
