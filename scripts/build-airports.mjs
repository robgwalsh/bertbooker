// Generates seed/airports.sql from the public-domain OurAirports dataset.
//
//   npm run build:airports
//
// Downloads airports.csv, keeps every non-closed airport, and writes batched
// INSERT statements that mirror the `airports` table (migrations/0001_init.sql).
// The seed lives OUTSIDE migrations/ so it stays re-runnable (same convention as
// seed/programs.sql). Load it with `npm run db:seed:airports:local` (uses
// `wrangler d1 import`, which streams the ~10MB file).
//
// Data: OurAirports (https://ourairports.com/data/) — public domain.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "seed/airports.sql");
const BATCH = 500;

// Minimal RFC-4180 CSV parser (fields may be quoted and contain commas / quotes
// / newlines). Returns an array of string arrays.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore; handled by the \n branch
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const sql = (v) => (v == null || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => {
  const n = Number(v);
  return v === "" || v == null || Number.isNaN(n) ? "NULL" : String(n);
};

async function main() {
  console.log(`Downloading ${CSV_URL} …`);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const text = await res.text();

  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error("Empty CSV");
  const col = Object.fromEntries(header.map((name, idx) => [name, idx]));
  const pick = (r, name) => (col[name] != null ? r[col[name]] : undefined);

  const records = [];
  for (const r of rows) {
    if (r.length <= 1) continue; // trailing blank line
    const type = pick(r, "type");
    if (type === "closed") continue;
    const ident = pick(r, "ident");
    const name = pick(r, "name");
    if (!ident || !name) continue;
    records.push({
      ident,
      type,
      name,
      iata: pick(r, "iata_code") || "",
      icao: pick(r, "icao_code") || pick(r, "gps_code") || "",
      city: pick(r, "municipality") || "",
      country: pick(r, "iso_country") || "",
      region: pick(r, "iso_region") || "",
      continent: pick(r, "continent") || "",
      latitude: pick(r, "latitude_deg"),
      longitude: pick(r, "longitude_deg"),
      scheduled: pick(r, "scheduled_service") === "yes" ? 1 : 0,
    });
  }

  console.log(`Parsed ${records.length} airports (excluding closed).`);

  // ONE ROW PER IATA CODE, and this is the only place it is enforced.
  //
  // Every join that resolves a code to an airport — the Tools route table, its
  // map, `airportCoords` — is a plain `LEFT JOIN airports ON iata = ?`. Those
  // used to be `(SELECT … GROUP BY iata)` derived tables defending against
  // duplicates, which SQLite MATERIALIZED on every use: a full walk of the
  // 72,454-row iata index, up to four times per `/routes/geo` request, to look
  // up a handful of codes. Enforcing the invariant here instead is what let
  // them become index seeks.
  //
  // So a duplicate must FAIL THE BUILD rather than pass quietly. The seed uses
  // `INSERT OR REPLACE`, so a duplicate would not raise anything at load time —
  // it would just make one pair of the route graph render twice, which is the
  // kind of bug nobody traces back to an airport file. Upstream is clean today
  // (9,054 codes, 9,054 distinct); if that changes, decide which row wins here,
  // deliberately.
  const byIata = new Map();
  const dupes = [];
  for (const a of records) {
    if (!a.iata) continue;
    if (byIata.has(a.iata)) dupes.push(`${a.iata}: ${byIata.get(a.iata)} and ${a.ident}`);
    else byIata.set(a.iata, a.ident);
  }
  if (dupes.length) {
    throw new Error(
      `OurAirports now has ${dupes.length} duplicate IATA code(s), which the ` +
        `route-graph joins assume cannot happen:\n  ${dupes.slice(0, 10).join("\n  ")}\n` +
        `Resolve them here (pick one row per code) before writing the seed.`,
    );
  }

  const cols =
    "(ident, type, name, iata, icao, city, country, region, continent, latitude, longitude, scheduled)";
  const parts = [
    "-- Generated by scripts/build-airports.mjs from OurAirports (public domain).",
    "-- Do not edit by hand; re-run `npm run build:airports`.",
    "DELETE FROM airports;",
    "",
  ];
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const values = chunk
      .map(
        (a) =>
          `(${sql(a.ident)}, ${sql(a.type)}, ${sql(a.name)}, ${sql(a.iata)}, ${sql(a.icao)}, ` +
          `${sql(a.city)}, ${sql(a.country)}, ${sql(a.region)}, ${sql(a.continent)}, ` +
          `${num(a.latitude)}, ${num(a.longitude)}, ${a.scheduled})`,
      )
      .join(",\n");
    parts.push(`INSERT OR REPLACE INTO airports ${cols} VALUES\n${values};`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, parts.join("\n") + "\n", "utf8");
  const withIata = records.filter((a) => a.iata).length;
  console.log(`Wrote ${OUT} (${records.length} rows, ${withIata} with IATA codes).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
