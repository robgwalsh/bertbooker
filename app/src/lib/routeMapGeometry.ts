import { BORDERS, GEOMETRY_PRECISION, LAKES, LAND } from "../data/worldGeometry";

// The projection and path building behind RouteMap — pure functions over
// numbers, kept out of the component so they can be tested without a DOM and so
// the expensive half (culling ~450 rings to the handful a frame actually shows)
// can be memoized across the many rows of a trip list.
//
// Everything here works in DEGREES, not pixels. The SVG carries a viewBox in
// projected degree units and is scaled to whatever box the card gives it, so
// nothing in this file needs to know the widget's size — only its aspect ratio.

export interface GeoPoint {
  lon: number;
  lat: number;
}

/**
 * A fixed view of the world: an equirectangular projection plus the viewBox
 * that frames it. There is no zoom or pan, so this is computed once per route
 * and never changes.
 */
export interface MapFrame {
  /** Longitude scale — cos of the frame's centre latitude. See `project`. */
  kx: number;
  /** viewBox, in projected degree units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEG = Math.PI / 180;

/**
 * Equirectangular, with the standard parallel at the frame's centre latitude.
 *
 * Plain lon/lat would stretch a Seattle–London map to nearly twice its true
 * width; scaling longitude by cos(centre latitude) keeps landmasses close to
 * their real shape across the band the route actually crosses, which is all a
 * fixed regional view has to get right. It is not a great-circle-preserving
 * projection — the arc is sampled and drawn as a polyline instead, so it bends
 * correctly regardless.
 */
export function project(p: GeoPoint, frame: MapFrame): { x: number; y: number } {
  return { x: p.lon * frame.kx, y: -p.lat };
}

/** Where a point sits in the frame, as CSS percentages for an HTML overlay. */
export function toPercent(p: GeoPoint, frame: MapFrame): { left: number; top: number } {
  const { x, y } = project(p, frame);
  return {
    left: ((x - frame.x) / frame.width) * 100,
    top: ((y - frame.y) / frame.height) * 100,
  };
}

/**
 * Shift `lon` by whole turns until it is within 180° of `reference`.
 *
 * Every longitude in this file is "unwrapped" this way, which is what lets a
 * Pacific route be one continuous line instead of two fragments: SFO→NRT is
 * drawn from -122° to -220°, off the left edge of the conventional world, and
 * the basemap is repeated at that offset to meet it (`worldOffsets`).
 */
export function unwrapLon(lon: number, reference: number): number {
  return lon - Math.round((lon - reference) / 360) * 360;
}

/**
 * The great-circle path between two airports, sampled as a polyline.
 *
 * Sampled rather than drawn as a curve because a great circle is not any conic
 * section under this projection — the transpacific arc that bows up over the
 * Aleutians is the whole reason to draw a map instead of a straight line
 * between two dots.
 *
 * Interpolation is a slerp between the two points as 3-D unit vectors, so it is
 * stable across the poles and the antimeridian, both of which a lat/lon
 * midpoint gets wrong.
 */
export function greatCircle(a: GeoPoint, b: GeoPoint, samples = 48): GeoPoint[] {
  const toVec = (p: GeoPoint) => {
    const phi = p.lat * DEG;
    const lambda = p.lon * DEG;
    const cosPhi = Math.cos(phi);
    return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)] as const;
  };

  const u = toVec(a);
  const v = toVec(b);
  const dot = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const omega = Math.acos(dot);

  // Same airport, or close enough that the arc is shorter than a pixel. A slerp
  // would divide by ~0 here; the segment is a point either way.
  if (omega < 1e-6) return [a, { ...b, lon: unwrapLon(b.lon, a.lon) }];

  const sinOmega = Math.sin(omega);
  const out: GeoPoint[] = [];
  let previousLon = a.lon;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const ca = Math.sin((1 - t) * omega) / sinOmega;
    const cb = Math.sin(t * omega) / sinOmega;
    const x = ca * u[0] + cb * v[0];
    const y = ca * u[1] + cb * v[1];
    const z = ca * u[2] + cb * v[2];

    const lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
    // Unwrap against the PREVIOUS sample, not the origin: a route long enough to
    // pass 180° of longitude would otherwise fold back on itself halfway.
    const lon = unwrapLon(Math.atan2(y, x) / DEG, previousLon);
    previousLon = lon;
    out.push({ lon, lat });
  }

  return out;
}

/**
 * The full flown path: every leg's arc, end to end, in one continuous
 * longitude space. Fewer than two stops is not a route and yields nothing.
 */
export function routeArc(stops: GeoPoint[], samplesPerLeg = 48): GeoPoint[] {
  if (stops.length < 2) return [];
  const out: GeoPoint[] = [];
  let anchor = stops[0]!.lon;

  for (let i = 0; i < stops.length - 1; i++) {
    const from = { ...stops[i]!, lon: anchor };
    const to = { ...stops[i + 1]!, lon: unwrapLon(stops[i + 1]!.lon, anchor) };
    const leg = greatCircle(from, to, samplesPerLeg);
    // Drop the shared endpoint so the joint isn't a duplicate vertex.
    out.push(...(i === 0 ? leg : leg.slice(1)));
    anchor = leg[leg.length - 1]!.lon;
  }

  return out;
}

/**
 * Unwrap several paths into ONE shared longitude space.
 *
 * Each path continues from where the last one ended rather than restarting at
 * its own first stop, and that is load-bearing whenever a map holds two of them.
 * A round trip out SFO→NRT→SIN and back SIN→ICN→SFO unwrapped independently
 * puts the outbound at -256°..-122° and the return at +104°..+238° — the same
 * journey in two different copies of the world. Framed together they span 493°,
 * so the widget drew the whole earth twice at postage-stamp scale instead of the
 * north Pacific.
 *
 * Threading the anchor works because consecutive paths MEET: the return starts
 * where the outbound landed, so unwrapping its first stop against the outbound's
 * last one lands it in the same copy by construction.
 */
export function unwrapPaths(paths: GeoPoint[][]): GeoPoint[][] {
  let anchor: number | null = null;
  return paths.map((stops) => {
    const out: GeoPoint[] = [];
    for (const s of stops) {
      const lon = anchor === null ? s.lon : unwrapLon(s.lon, anchor);
      anchor = lon;
      out.push({ lon, lat: s.lat });
    }
    return out;
  });
}

/** The stops of a single path, unwrapped into the same longitude space as the
 *  arc drawn through them. */
export function unwrapStops(stops: GeoPoint[]): GeoPoint[] {
  return unwrapPaths([stops])[0]!;
}

/**
 * The smallest span, in projected units, the frame will ever show.
 *
 * A tightly cropped map of a short hop is a green smear: SEA→LAX framed to its
 * own bounding box shows two dots on a coastline with nothing to place them
 * against. Holding a floor of roughly a continent's width means every route
 * reads as somewhere, and it is also what makes 50m coastlines enough detail.
 */
const MIN_SPAN = 30;

/** Fraction of the content's span left as margin, so labels clear the edges. */
const PADDING = 0.42;

/**
 * How much closer in than the padded span the view actually sits.
 *
 * Applied last, about the frame's centre, so it is a plain zoom: the aspect
 * still matches the box and the route is still centred, there is just less
 * empty ocean around it. The margin left over is `(1 + PADDING) / ZOOM` of the
 * content's own span — keep that product above 1 or the padding stops being
 * padding and the frame starts cropping the arc it was framed on, which the
 * "contains every point" test in `routeMapGeometry.test.ts` is there to catch.
 */
const ZOOM = 1.15;

/**
 * Frame a set of points for a box of the given aspect ratio (width / height).
 *
 * The result is deliberately stable: it depends only on the points and the
 * aspect, so every row showing the same route computes the same frame and hits
 * the path cache.
 */
export function frameFor(points: GeoPoint[], aspect: number): MapFrame {
  if (!points.length) points = [{ lon: 0, lat: 20 }];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const centreLat = (minLat + maxLat) / 2;
  // Clamped away from the poles: cos(85°) is 0.09, which would stretch a
  // trans-polar map sideways by 11x.
  const kx = Math.max(Math.cos(centreLat * DEG), 0.25);

  const centreX = ((minLon + maxLon) / 2) * kx;
  const centreY = -centreLat;

  let width = Math.max((maxLon - minLon) * kx, MIN_SPAN) * (1 + PADDING);
  let height = Math.max(maxLat - minLat, MIN_SPAN / aspect) * (1 + PADDING);

  // Grow the deficient axis so the projection stays uniform — a viewBox whose
  // aspect differs from its box's would squash the coastlines and turn the
  // airport dots into ellipses.
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;

  // Zoom last: scaling both axes by the same factor leaves the aspect the
  // grow-the-deficient-axis step just fixed.
  width /= ZOOM;
  height /= ZOOM;

  return { kx, x: centreX - width / 2, y: centreY - height / 2, width, height };
}

// ---- Cartography ----

/**
 * The colours every map drawn from this geometry paints itself in.
 *
 * Literals rather than theme roles, because the app's palette has no "ocean" and
 * no "land" — a green-and-blue map is a picture of the world, not a piece of the
 * app's chrome. Pitched dark enough to sit in a dark table without glowing.
 *
 * They live here, beside the geometry, because there are now two maps drawn from
 * it — the trip list's `RouteMap` and the seats.aero pane's `RouteGraphMap` —
 * and the failure mode of a copy is one of them quietly drifting a shade.
 */
export const WATER = "#13304a";
export const LAND_FILL = "#2f6247";
export const COAST = "#57997a";
export const BORDER = "#ffffff";

/**
 * Default line colour, and the second one for the rare map that draws two paths.
 *
 * Fixed for the same reason the basemap is: over green and blue, the line is the
 * only thing meant to catch the eye, and a theme whose accent happened to be a
 * deep blue would sink into the ocean. Indigo is the theme's primary; both read
 * clearly over the basemap, and neither is a colour it uses.
 */
export const ROUTE_COLOR = "#38e0c8";
export const ROUTE_ALT_COLOR = "#9aa8ff";

// ---- Basemap ----

interface Shape {
  /** Flat [lon, lat, lon, lat, …] in degrees. */
  coords: number[];
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** Undo `build-world-geometry.mjs`'s delta+quantize encoding. */
export function decodeRing(encoded: string): number[] {
  const deltas = encoded.split(",");
  const coords = new Array<number>(deltas.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < deltas.length; i += 2) {
    x += Number(deltas[i]);
    y += Number(deltas[i + 1]);
    coords[i] = x / GEOMETRY_PRECISION;
    coords[i + 1] = y / GEOMETRY_PRECISION;
  }
  return coords;
}

function toShapes(rings: readonly string[]): Shape[] {
  return rings.map((encoded) => {
    const coords = decodeRing(encoded);
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (let i = 0; i < coords.length; i += 2) {
      const lon = coords[i]!;
      const lat = coords[i + 1]!;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { coords, minLon, maxLon, minLat, maxLat };
  });
}

// Decoded once per layer, on first use, and shared by every widget on the page.
let decoded: { land: Shape[]; lakes: Shape[]; borders: Shape[] } | null = null;
function shapes() {
  if (!decoded) {
    decoded = { land: toShapes(LAND), lakes: toShapes(LAKES), borders: toShapes(BORDERS) };
  }
  return decoded;
}

/**
 * Which copies of the world the frame overlaps.
 *
 * The stored geometry spans -180..180 once. A frame that has been unwrapped
 * past the antimeridian — anything crossing the Pacific — needs the same
 * geometry redrawn a turn to the left or right to meet it.
 */
export function worldOffsets(frame: MapFrame): number[] {
  const lonMin = frame.x / frame.kx;
  const lonMax = (frame.x + frame.width) / frame.kx;
  const first = Math.floor((lonMin + 180) / 360);
  const last = Math.floor((lonMax + 180) / 360);
  const offsets: number[] = [];
  for (let k = first; k <= last; k++) offsets.push(k * 360);
  return offsets;
}

/** Coordinates are quantized to 0.1°, so two decimals of SVG is already more
 *  precision than the source has. Rounding here is most of the path length. */
const round = (n: number) => Math.round(n * 100) / 100;

function shapePath(shape: Shape, frame: MapFrame, offset: number, close: boolean): string {
  const { coords } = shape;
  let d = "";
  for (let i = 0; i < coords.length; i += 2) {
    const x = round((coords[i]! + offset) * frame.kx);
    const y = round(-coords[i + 1]!);
    d += `${i === 0 ? "M" : "L"}${x} ${y}`;
  }
  return close ? `${d}Z` : d;
}

function layerPath(layer: Shape[], frame: MapFrame, offsets: number[], close: boolean): string {
  const lonMin = frame.x / frame.kx;
  const lonMax = (frame.x + frame.width) / frame.kx;
  const latMin = -(frame.y + frame.height);
  const latMax = -frame.y;

  let d = "";
  for (const offset of offsets) {
    for (const shape of layer) {
      // Cheap reject: most of a world basemap is nowhere near any one route.
      if (shape.maxLon + offset < lonMin || shape.minLon + offset > lonMax) continue;
      if (shape.maxLat < latMin || shape.minLat > latMax) continue;
      d += shapePath(shape, frame, offset, close);
    }
  }
  return d;
}

export interface BasemapPaths {
  land: string;
  lakes: string;
  borders: string;
}

// One entry per distinct frame. A trip list draws one map per row and they are
// overwhelmingly the same route, so this is close to a single computation per
// page; the cap only exists so a long session can't accumulate frames forever.
const CACHE_LIMIT = 32;
const cache = new Map<string, BasemapPaths>();

/** Land, lakes and borders as SVG path data for one frame. Memoized. */
export function basemapPaths(frame: MapFrame): BasemapPaths {
  const key = [frame.kx, frame.x, frame.y, frame.width, frame.height]
    .map((n) => n.toFixed(3))
    .join("|");

  const hit = cache.get(key);
  if (hit) return hit;

  const offsets = worldOffsets(frame);
  const layers = shapes();
  const paths: BasemapPaths = {
    land: layerPath(layers.land, frame, offsets, true),
    lakes: layerPath(layers.lakes, frame, offsets, true),
    borders: layerPath(layers.borders, frame, offsets, false),
  };

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, paths);
  return paths;
}

export interface BasemapRings {
  land: [number, number][][];
  lakes: [number, number][][];
  borders: [number, number][][];
}

/**
 * The same basemap as Leaflet-ready rings: `[lat, lon]`, the order Leaflet
 * takes, rather than the `[lon, lat]` the storage uses.
 *
 * `basemapPaths` projects into a fixed SVG frame and culls to it; this one does
 * neither, because a Leaflet map owns its own projection and viewport. Same
 * geometry, two consumers with genuinely different needs — which is why the
 * decode (`shapes()`) is shared and the rest is not.
 *
 * `offsets` are whole turns of longitude. Leaflet repeats raster TILES across
 * copies of the world for free and repeats VECTORS not at all, so a map that can
 * pan past the antimeridian has to be handed the geometry again at ±360 or the
 * world simply stops at the edge.
 */
export function basemapRings(offsets: readonly number[] = [0]): BasemapRings {
  const layers = shapes();

  const convert = (layer: Shape[]): [number, number][][] => {
    const out: [number, number][][] = [];
    for (const offset of offsets) {
      for (const shape of layer) {
        const ring: [number, number][] = new Array(shape.coords.length / 2);
        for (let i = 0; i < shape.coords.length; i += 2) {
          ring[i / 2] = [shape.coords[i + 1]!, shape.coords[i]! + offset];
        }
        out.push(ring);
      }
    }
    return out;
  };

  return {
    land: convert(layers.land),
    lakes: convert(layers.lakes),
    borders: convert(layers.borders),
  };
}

/**
 * Do these two paths retrace each other?
 *
 * The round-trip table's answer to "one map or two lines": a return that flies
 * the outbound backwards is the SAME LINE, and drawing it twice buys a second
 * colour and a legend to say nothing. A return through a different connection
 * — out via Tokyo, back via Seoul — is a different fact about the trip, and
 * earns its own line.
 *
 * Compared by airport code rather than by coordinate: two rows for one IATA code
 * are the same place, and floating-point latitudes that differ in the last bit
 * are not a different route.
 */
export function isSamePath(
  out: readonly { code: string }[],
  back: readonly { code: string }[],
): boolean {
  if (out.length !== back.length) return false;
  return out.every((s, i) => s.code === back[back.length - 1 - i]!.code);
}

/** A polyline of geo points as SVG path data. */
export function linePath(points: GeoPoint[], frame: MapFrame): string {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const { x, y } = project(points[i]!, frame);
    d += `${i === 0 ? "M" : "L"}${round(x)} ${round(y)}`;
  }
  return d;
}
