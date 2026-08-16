// Generates web/src/data/worldGeometry.ts — the basemap the route widget draws.
//
//   npm run build:world
//
// Downloads Natural Earth (public domain), simplifies it hard, and writes a
// TypeScript module of delta-encoded coordinate strings. It is committed so the
// build needs no network, and it is GENERATED — do not hand-edit.
//
// Why a baked-in vector basemap instead of the tile server AirportMap.tsx uses:
// the route widget renders once per row of the trip list, is fixed (no zoom, no
// pan) and must be readable at ~320px. Tiles would mean dozens of network round
// trips per page for imagery far more detailed than that size can show, and the
// dark cartography can't do "green land, blue water". Vectors we project
// ourselves cost one module and render synchronously.
//
// Resolution is chosen per layer for what survives simplification at widget
// size: coastlines at 50m (a 110m US west coast is a smooth blob — no Puget
// Sound, no Baja), borders at 110m (they are hairlines; 50m detail is invisible
// and costs 5x). Lakes matter more than they look — the Great Lakes and the
// Caspian are the landmarks that place a domestic route at a glance.
//
// Data: Natural Earth via martynafford/natural-earth-geojson — public domain.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "web/src/data/worldGeometry.ts");

// Coordinates are stored in tenths of a degree (~11km) — one pixel at the
// widest view this widget ever shows, so nothing visible is lost.
const PRECISION = 10;

const LAYERS = {
  // [url, simplification tolerance in degrees, minimum ring area in deg²]
  land: [`${BASE}/50m/physical/ne_50m_land.json`, 0.15, 0.25],
  lakes: [`${BASE}/50m/physical/ne_50m_lakes.json`, 0.12, 0.35],
  borders: [`${BASE}/110m/cultural/ne_110m_admin_0_boundary_lines_land.json`, 0.25, 0],
};

// Ramer–Douglas–Peucker, iterative so a 4000-point coastline can't blow the
// stack. Distances are in degrees, which over-weights high latitudes — that is
// the right bias here, since those are the parts a small map can least afford
// to spend points on.
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);

    let farthest = -1;
    let maxDist = 0;
    for (let i = start + 1; i < end; i++) {
      const [x, y] = points[i];
      const dist =
        len === 0
          ? Math.hypot(x - x1, y - y1)
          : Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / len;
      if (dist > maxDist) {
        maxDist = dist;
        farthest = i;
      }
    }

    if (farthest > 0 && maxDist > tolerance) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Shoelace area in deg² — the cheap proxy for "is this island worth a ring?".
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum / 2);
}

// Snap to the storage grid and drop points that collapsed onto their neighbour.
function quantize(points) {
  const out = [];
  for (const [lon, lat] of points) {
    const x = Math.round(lon * PRECISION);
    const y = Math.round(lat * PRECISION);
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  return out;
}

// Delta encoding: coastlines are dense, so successive points differ by a digit
// or two while absolute coordinates cost five. Roughly halves the file.
function encode(points) {
  const parts = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of points) {
    parts.push(x - px, y - py);
    px = x;
    py = y;
  }
  return parts.join(",");
}

// A GeoJSON geometry yields one or more coordinate lists. For polygons we take
// only the outer ring: at this scale a hole is at most a few pixels, and
// keeping them would mean the renderer needs even-odd fill rules to match.
function ringsOf(geometry) {
  const { type, coordinates } = geometry;
  if (type === "LineString") return [coordinates];
  if (type === "MultiLineString") return coordinates;
  if (type === "Polygon") return [coordinates[0]];
  if (type === "MultiPolygon") return coordinates.map((polygon) => polygon[0]);
  return [];
}

async function buildLayer(name, [url, tolerance, minArea]) {
  console.log(`Downloading ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: download failed — ${res.status} ${res.statusText}`);
  const { features } = await res.json();

  const encoded = [];
  let points = 0;
  for (const feature of features) {
    for (const ring of ringsOf(feature.geometry)) {
      // Filter before AND after simplifying: a sliver can survive the first
      // check and collapse to a zero-area spike in the second.
      if (minArea && ringArea(ring) < minArea) continue;
      const reduced = quantize(simplify(ring, tolerance));
      if (reduced.length < 2) continue;
      if (minArea && ringArea(reduced.map(([x, y]) => [x / PRECISION, y / PRECISION])) < minArea) {
        continue;
      }
      encoded.push(encode(reduced));
      points += reduced.length;
    }
  }

  console.log(`  ${name}: ${encoded.length} rings, ${points} points`);
  return encoded;
}

async function main() {
  const layers = {};
  for (const [name, spec] of Object.entries(LAYERS)) {
    layers[name] = await buildLayer(name, spec);
  }

  const literal = (rings) => `[\n${rings.map((r) => `  ${JSON.stringify(r)},`).join("\n")}\n]`;

  const source = `// GENERATED by scripts/build-world-geometry.mjs — do not edit by hand.
// Re-run \`npm run build:world\` (needs internet).
//
// Natural Earth (public domain): 50m coastlines and lakes, 110m country
// borders, simplified for a ~320px widget and quantized to tenths of a degree.
// Each ring is a delta-encoded "dx,dy,dx,dy,…" string starting from (0,0);
// decode with \`decodeRing\` in ../routeMapGeometry.ts.

/** Storage grid: coordinates are integer tenths of a degree. */
export const GEOMETRY_PRECISION = ${PRECISION};

/** Coastlines — closed rings, filled as land. */
export const LAND: readonly string[] = ${literal(layers.land)};

/** Major lakes — closed rings, filled back in as water. */
export const LAKES: readonly string[] = ${literal(layers.lakes)};

/** Country boundaries — open lines, stroked. */
export const BORDERS: readonly string[] = ${literal(layers.borders)};
`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, source, "utf8");
  console.log(`Wrote ${OUT} (${(source.length / 1024).toFixed(0)} KB).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
