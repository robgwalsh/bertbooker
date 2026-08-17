import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  basemapPaths,
  frameFor,
  linePath,
  routeArc,
  toPercent,
  unwrapPaths,
  type GeoPoint,
} from "../../lib/routeMapGeometry";

/**
 * Where a route actually goes, as a small map beside its itinerary card.
 *
 * Sized by its caller, never by itself — in a table that is `RouteMapFill`,
 * which hands it whatever height the row already had.
 *
 * The card next to this one is a topology diagram — how many stops, how long on
 * the ground — and says nothing about geography. That is the gap this fills: it
 * is what tells you at a glance that a "1 stop" SEA→SIN routes through Tokyo
 * rather than Doha, and that the transpacific leg goes over the Aleutians.
 *
 * DELIBERATELY INERT. No zoom, no pan, no click, no hover state, no tiles. It
 * renders once per row of a trip list — fifteen of them on a page — so anything
 * interactive would be fifteen event surfaces competing with the table's own
 * scrolling, and anything network-backed would be fifteen requests per page. The
 * basemap is a vector module compiled into the bundle
 * (`data/worldGeometry.ts`), the projection is arithmetic, and the whole thing
 * is one `<svg>` plus a label per stop.
 *
 * Not the Airports pane's `AirportMap`, and not extensible into it: that one is
 * a Leaflet instance over a dark tile server, built to cluster ~72k points under
 * pan and zoom. Nothing about it survives being shrunk to a table cell.
 */

/** The column's width, exported so the tables can size their track to the widget
 *  rather than guessing at it. Width is fixed; HEIGHT IS NOT — in a table the
 *  map takes whatever the row already is, which is `RouteMapFill`'s whole job.
 *  This height is only the fallback for a caller that sizes nothing. */
export const ROUTE_MAP_WIDTH = 232;
export const ROUTE_MAP_HEIGHT = 132;

/**
 * Cartography, not chrome, so these are literals rather than theme roles — the
 * app's palette has no "ocean". Green land and blue water as asked, pitched
 * dark enough to sit in a dark table without glowing: the route line is the only
 * thing here meant to catch the eye, and it is the theme's teal precisely
 * because nothing on a green-and-blue map competes with it.
 */
const WATER = "#13304a";
const LAND = "#2f6247";
const COAST = "#57997a";
const BORDER = "#ffffff";

/** Default line colour, and the second one for the rare map that draws two
 *  paths. Indigo is the theme's primary; both read clearly over green and blue,
 *  and neither is a colour the basemap uses. */
export const ROUTE_COLOR = "#38e0c8";
export const ROUTE_ALT_COLOR = "#9aa8ff";

export interface RouteStop {
  code: string;
  latitude: number;
  longitude: number;
  /** City or airport name, for the tooltip. The map itself only ever draws the
   *  code — a cell this size cannot hold "San Francisco" twice. */
  label?: string | null;
}

/** One line on the map. Callers pass more than one only when the paths are
 *  genuinely different — see `RouteMap`. */
export interface RoutePath {
  stops: RouteStop[];
  color?: string;
  /** Legend entry, drawn only when there is more than one path. */
  label?: string;
}

/** Roughly what a three-letter code in its pill measures, and how far the pill
 *  sits from its dot. Approximate on purpose — this only has to decide which
 *  side of the dot to use, not lay out text. */
const LABEL_WIDTH = 34;
const LABEL_HEIGHT = 15;
const LABEL_GAP = 9;

interface Mark {
  left: number;
  top: number;
  code: string;
  /** Label above the dot, or below it. */
  above: boolean;
}

/**
 * Put each label above its dot, or below it when above is already taken.
 *
 * Airports are usually far enough apart that this never fires, and then it
 * fires exactly where it matters: a Tokyo connection against a Seoul one is
 * about ten pixels at this scale, and two labels stacked on the same line
 * rendered as `ICNRT`. Greedy and first-come — with at most a handful of stops
 * there is nothing to gain from solving it properly.
 */
function placeLabels(
  marks: { left: number; top: number; code: string }[],
  width: number,
  height: number,
): Mark[] {
  const taken: { x: number; top: number; bottom: number }[] = [];

  return marks.map((m) => {
    const x = (m.left / 100) * width;
    const y = (m.top / 100) * height;
    // Above by default; below first only when there is no room above, which is
    // the frame's own top edge.
    const order = m.top < 24 ? [false, true] : [true, false];

    const boxFor = (above: boolean) => {
      const top = above ? y - LABEL_GAP - LABEL_HEIGHT : y + LABEL_GAP;
      return { x, top, bottom: top + LABEL_HEIGHT };
    };

    const above =
      order.find((candidate) => {
        const box = boxFor(candidate);
        return !taken.some(
          (t) => Math.abs(t.x - x) < LABEL_WIDTH && box.top < t.bottom && box.bottom > t.top,
        );
      }) ?? order[0]!;

    taken.push(boxFor(above));
    return { ...m, above };
  });
}

export function RouteMap({
  paths,
  width = ROUTE_MAP_WIDTH,
  height = ROUTE_MAP_HEIGHT,
}: {
  /**
   * The lines to draw, framed together.
   *
   * More than one is for a round trip whose two legs route DIFFERENTLY — out via
   * Tokyo, back via Seoul. Two legs that retrace each other must be passed as a
   * single path: drawn as two they would be one line under another, which is a
   * legend and a second colour spent saying nothing.
   */
  paths: RoutePath[];
  width?: number;
  height?: number;
}) {
  const drawing = useMemo(() => {
    const drawable = paths.filter((p) => p.stops.length >= 2);
    if (!drawable.length) return null;

    // One shared longitude space for every path — see `unwrapPaths`. Unwrapping
    // each on its own puts a round trip's two halves in different copies of the
    // world and frames the whole earth to fit both.
    const pointSets = unwrapPaths(
      drawable.map((p) => p.stops.map((s) => ({ lon: s.longitude, lat: s.latitude }))),
    );
    const arcs = pointSets.map((points) => routeArc(points));

    // Framed on the ARCS, not on the endpoints: a great circle bows a long way
    // off the straight line between them, and framing on the stops alone would
    // crop the very bend that makes the map worth drawing. Both paths share one
    // frame, so a return that swings somewhere the outbound didn't widens the
    // view for both.
    const frame = frameFor(arcs.flat(), width / height);

    // Airports, deduplicated across the paths: a round trip names every one of
    // them twice, and two labels on one dot is just a thicker label.
    const marks = new Map<string, { left: number; top: number; code: string }>();
    pointSets.forEach((points, i) => {
      points.forEach((p, j) => {
        const code = drawable[i]!.stops[j]!.code;
        if (!marks.has(code)) marks.set(code, { ...toPercent(p, frame), code });
      });
    });

    return {
      frame,
      basemap: basemapPaths(frame),
      lines: arcs.map((arc, i) => ({
        d: linePath(arc, frame),
        color: drawable[i]!.color ?? ROUTE_COLOR,
        label: drawable[i]!.label,
      })),
      marks: placeLabels([...marks.values()], width, height),
    };
  }, [paths, width, height]);

  if (!drawing) return null;

  const { frame, basemap, marks, lines } = drawing;
  const viewBox = `${frame.x} ${frame.y} ${frame.width} ${frame.height}`;
  const summary = paths
    .filter((p) => p.stops.length >= 2)
    .map(
      (p) => `${p.label ? `${p.label}: ` : ""}${p.stops.map((s) => s.label || s.code).join(" → ")}`,
    )
    .join(" · ");
  // Only earns its space when there is something to tell apart.
  const legend = lines.length > 1 ? lines.filter((l) => l.label) : [];

  return (
    <Tooltip title={summary}>
      <Box
        sx={{
          position: "relative",
          width,
          height,
          flexShrink: 0,
          borderRadius: 1.5,
          overflow: "hidden",
          bgcolor: WATER,
          border: (t) => `1px solid ${alpha(t.palette.common.white, 0.1)}`,
          // A picture, not a control: nothing inside is clickable or draggable,
          // and the only pointer behaviour is the tooltip on this box. Note that
          // `pointerEvents: "none"` here would be wrong — it would take the
          // tooltip's own hover with it.
          userSelect: "none",
        }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={viewBox}
          // Aspects match by construction, so this only matters if a caller
          // squeezes the box — and cropping is a better failure than distorted
          // coastlines with the labels still on the old grid.
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label={`Map of ${summary}`}
          style={{ display: "block", pointerEvents: "none" }}
        >
          <path d={basemap.land} fill={LAND} stroke={COAST} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
          {/* Lakes are painted back in as water AFTER the land, which is why they
              are a separate layer rather than holes in the coastline rings: the
              Great Lakes and the Caspian are how a domestic route reads as being
              somewhere at this size. */}
          <path d={basemap.lakes} fill={WATER} stroke={COAST} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          <path
            d={basemap.borders}
            fill="none"
            stroke={alpha(BORDER, 0.22)}
            strokeWidth={0.7}
            vectorEffect="non-scaling-stroke"
          />
          {/* Every path's halo before any crisp line, so a second route can't
              lay its own soft wash over the first one's sharp edge. The halo is
              what keeps a line findable where it crosses pale coastline. */}
          {lines.map((l, i) => (
            <path
              key={`halo-${i}`}
              d={l.d}
              fill="none"
              stroke={alpha(l.color, 0.3)}
              strokeWidth={5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {lines.map((l, i) => (
            <path
              key={`line-${i}`}
              d={l.d}
              fill="none"
              stroke={l.color}
              strokeWidth={1.8}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* Stops as an HTML overlay rather than SVG circles and <text>: the
            viewBox is in degrees, so anything drawn inside it is sized by the
            projection — a dot would be an ellipse on a tall frame and a label
            would be set in whatever point size the scale happened to imply. Out
            here they are plain pixels in the app's own type. */}
        {marks.map((m, i) => (
          <Box key={`${m.code}-${i}`}>
            <Box
              sx={{
                position: "absolute",
                left: `${m.left}%`,
                top: `${m.top}%`,
                transform: "translate(-50%, -50%)",
                width: 7,
                height: 7,
                borderRadius: "50%",
                bgcolor: "#fff",
                border: `1.5px solid ${lines[0]!.color}`,
                boxShadow: "0 0 4px rgba(0,0,0,0.6)",
              }}
            />
            <Typography
              variant="caption"
              sx={{
                position: "absolute",
                left: `${m.left}%`,
                top: `${m.top}%`,
                // Side chosen by `placeLabels`. Only the vertical ever flips —
                // the frame's padding is what guarantees the horizontal room.
                transform: m.above
                  ? `translate(-50%, calc(-100% - ${LABEL_GAP}px))`
                  : `translate(-50%, ${LABEL_GAP}px)`,
                px: 0.5,
                borderRadius: 0.5,
                fontWeight: 700,
                fontSize: 10,
                lineHeight: 1.4,
                letterSpacing: "0.04em",
                color: "#fff",
                bgcolor: alpha("#000", 0.55),
                whiteSpace: "nowrap",
              }}
            >
              {m.code}
            </Typography>
          </Box>
        ))}

        {/* Only ever drawn for a round trip whose legs diverge — which is the
            only case where the map holds two lines and you would otherwise have
            no way to tell which way round they go. */}
        {legend.length > 0 && (
          <Box
            sx={{
              position: "absolute",
              left: 4,
              bottom: 4,
              display: "flex",
              gap: 0.75,
              px: 0.5,
              py: 0.25,
              borderRadius: 0.5,
              bgcolor: alpha("#000", 0.55),
            }}
          >
            {legend.map((l) => (
              <Box key={l.label} sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
                <Box sx={{ width: 8, height: 2, borderRadius: 1, bgcolor: l.color }} />
                <Typography
                  variant="caption"
                  sx={{ fontSize: 9, lineHeight: 1.2, fontWeight: 600, color: "#fff" }}
                >
                  {l.label}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

/** Breathing room between the map and the row's rules. It is stated here rather
 *  than left to the cell's padding because an absolutely positioned child is
 *  laid out against the padding BOX and so ignores it — which is also why the
 *  cells that hold this give themselves `p: 0`. */
export const ROUTE_MAP_INSET = 6;

/** What the Map column reserves: the widget plus its inset either side. */
export const ROUTE_MAP_CELL_WIDTH = ROUTE_MAP_WIDTH + ROUTE_MAP_INSET * 2;

/**
 * The map as a table cell that CANNOT make its row taller.
 *
 * A fixed-height map is the tallest thing in most rows — a nonstop's itinerary
 * card is well under the 132px the widget wants — so without this, the table
 * would grow to fit a picture instead of its data. The row should be as tall
 * as the itinerary needs and the map should take what is left.
 *
 * Two halves make that work, and both are load-bearing:
 *
 * - The widget is **absolutely positioned**, so it contributes nothing to the
 *   cell's content height and the row is measured on the other cells alone.
 *   The cell must therefore be the containing block (`position: relative`).
 * - The box is **measured**, and the measurement is what `RouteMap` is sized
 *   with. Letting the SVG simply stretch would not do: the frame is built for
 *   one aspect ratio and every stop label is positioned as a percentage OF THAT
 *   FRAME, so a box of another shape crops (`preserveAspectRatio="slice"`) and
 *   slides each label off its dot.
 *
 * Nothing is drawn until the first measurement lands. The column's width is
 * fixed by the caller, so there is no layout jump when it does — the same
 * reason that width is `minWidth` as well.
 */
export function RouteMapFill({ paths }: { paths: RoutePath[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      // Whole pixels, and stored only when they CHANGE. Sub-pixel row heights
      // would otherwise give every row a frame of its own — a basemap cache
      // miss per row of one route — and a re-render per observation.
      const width = Math.round(node.clientWidth);
      const height = Math.round(node.clientHeight);
      setBox((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Box ref={ref} sx={{ position: "absolute", inset: `${ROUTE_MAP_INSET}px` }}>
      {box && box.width > 0 && box.height > 0 && (
        <RouteMap paths={paths} width={box.width} height={box.height} />
      )}
    </Box>
  );
}

/**
 * Turn a find's airport codes into plottable stops, dropping any the airport
 * table cannot place.
 *
 * A missing coordinate is silently skipped rather than faked: OurAirports has
 * rows without lat/lon, and a code the lookup didn't resolve at all is simply
 * absent from the map. Below two plottable stops there is no route to draw, and
 * `RouteMap` renders nothing.
 */
export function toRouteStops(
  codes: string[],
  airports: Map<string, { latitude: number | null; longitude: number | null; city: string | null; name: string }>,
): RouteStop[] {
  const out: RouteStop[] = [];
  for (const code of codes) {
    const a = airports.get(code);
    if (!a || a.latitude == null || a.longitude == null) continue;
    out.push({ code, latitude: a.latitude, longitude: a.longitude, label: a.city || a.name });
  }
  return out;
}
