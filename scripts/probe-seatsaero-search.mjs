// Measures what Cached Search costs and returns when asked for trip detail.
//
//   node scripts/probe-seatsaero-search.mjs --from SFO --to NRT --days 120
//   node scripts/probe-seatsaero-search.mjs --from SFO,OAK --to NRT,HND --days 120
//   node scripts/probe-seatsaero-search.mjs --routes alaska
//   node scripts/probe-seatsaero-search.mjs --bulk alaska
//
// WHY THIS EXISTS
// ---------------
// `GET /partnerapi/search` takes parameters this repo has never sent, and two of
// them change the architecture rather than the query:
//
//   include_trips   "Include trip-level details in the API response. This may
//                    degrade response time and sizing."
//   origin_airport  "A list of origin airports. Comma-delimited if multiple."
//
// If trips ride along on the search response, a find arrives with real legs for
// **no extra metered call** and `/trips/{id}` enrichment stops being the only way
// to learn what aeroplane a row describes. If comma-delimited airports work, N
// origins x M destinations is one call rather than N*M.
//
// The parameters are documented. What is NOT documented, and is the thing that
// decides whether we can use them, is **how big the response gets** — the Worker
// holds a page in memory and streams a bounded capture of it to the SPA. So this
// probe measures bytes, not just shape. It reports and compares; it does not
// guess.
//
// WHAT IT COSTS
// -------------
// **One call per variant**, out of 1000 per UTC day — the same allowance Search
// spends. The default run is 4 variants, so 4 calls. `--routes` and `--bulk` are
// one call each. The remaining allowance is printed after every request, read off
// the same `X-RateLimit-Remaining` header `parseQuotaHeaders` reads.
//
// Fixtures are committed forever, so the key is redacted and long arrays are
// trimmed. Read the file before committing it.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Beside the tests that import them (`./__fixtures__/<stem>.json`). A capture
// written anywhere else is read by nothing.
const FIXTURE_DIR = resolve(ROOT, "api/src/providers/__fixtures__");
const BASE = "https://seats.aero/partnerapi";
const REDACTED = "<redacted>";
const REQUEST_TIMEOUT_MS = 60_000;

// --- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function usage(msg) {
  if (msg) console.error(`\nerror: ${msg}`);
  console.error(`
usage: node scripts/probe-seatsaero-search.mjs --from <IATA[,IATA]> --to <IATA[,IATA]>

  --from/--to <list>  comma-delimited airports (the multi-airport claim under test)
  --days <n>          offset from today for the window start (default 120)
  --span <n>          window length in days (default 90, the chunk size we use)
  --sources <list>    restrict to these seats.aero sources
  --only <variant>    run one of: baseline, trips, minified, small
  --trim <n>          keep at most n elements per array in the fixture (default 3)
  --out <stem>        fixture filename stem (default "seatsaero-search-trips")
  --no-write          probe and report, write nothing

ledger probes (one call each, no fixture unless --out is given):
  --routes <source>   GET /partnerapi/routes?source=<name>   (undocumented)
  --bulk <source>     GET /partnerapi/availability?source=<name>
`);
  process.exit(msg ? 1 : 0);
}

// --- the key ---------------------------------------------------------------

/**
 * The key lives in the Worker's own gitignored `.dev.vars`, not in this
 * script's environment. Read it from there rather than making the operator
 * export it: getting a probe to run should not require reconstructing the
 * Worker's environment.
 */
function readApiKey() {
  if (process.env.SEATS_AERO_API_KEY) return process.env.SEATS_AERO_API_KEY;
  const file = resolve(ROOT, "api/.dev.vars");
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*SEATS_AERO_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return null;
}

// --- redaction + trimming --------------------------------------------------

const SENSITIVE = /^(partner-authorization|authorization|cookie|set-cookie)$/i;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = SENSITIVE.test(k) ? REDACTED : v;
  return out;
}

function trimDeep(value, max, depth = 0) {
  if (depth > 40) return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, max).map((v) => trimDeep(v, max, depth + 1));
    if (value.length > max) kept.push(`<trimmed ${value.length - max} more>`);
    return kept;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimDeep(v, max, depth + 1);
    return out;
  }
  return value;
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

// --- transport -------------------------------------------------------------

async function get(url, apiKey) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { "Partner-Authorization": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const remaining = headers["x-ratelimit-remaining"];
  console.log(
    `  ${res.ok ? "✓" : "✗"} http ${res.status} · ${kb(text.length)} · ${Date.now() - startedAt}ms` +
      (remaining != null ? ` · ${remaining} calls left today` : " · NO x-ratelimit-remaining header"),
  );
  return { status: res.status, ok: res.ok, headers, text, durationMs: Date.now() - startedAt };
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// --- the four variants -----------------------------------------------------

/**
 * Each variant is one call. `baseline` is exactly what `buildSearchUrl` sends
 * today, so every other row in the report is a delta against the status quo
 * rather than against nothing.
 */
const VARIANTS = [
  { name: "baseline", take: "1000", params: {} },
  { name: "trips", take: "1000", params: { include_trips: "true" } },
  { name: "minified", take: "1000", params: { include_trips: "true", minify_trips: "true" } },
  { name: "small", take: "200", params: { include_trips: "true", minify_trips: "true" } },
];

function searchUrl(args, variant) {
  const today = new Date().toISOString().slice(0, 10);
  const start = addDaysISO(today, Number(args.days ?? 120));
  const params = new URLSearchParams({
    origin_airport: String(args.from).toUpperCase(),
    destination_airport: String(args.to).toUpperCase(),
    start_date: start,
    end_date: addDaysISO(start, Number(args.span ?? 90)),
    take: variant.take,
    ...variant.params,
  });
  if (typeof args.sources === "string") params.set("sources", args.sources);
  return `${BASE}/search?${params}`;
}

/**
 * What the report is actually for.
 *
 * Rows, trip payload weight, which pairs came back — and one thing that is a
 * hard gate rather than a curiosity: **is the response ordered globally by
 * departure date, or grouped by pair?**
 *
 * `runSeatsAeroChunk` narrows its own coverage claim when it paginates out, and
 * that narrowing (`covered = dates <= maxDate`) is sound only because ordering
 * is by date, so a truncated read loses the far end of the window and ONLY the
 * far end. Ask about several pairs at once and that stops being obviously true.
 * If the response is grouped by pair, a truncated read loses whole pairs' late
 * dates while other pairs look complete — and narrowing to a single global
 * `maxDate` would then OVER-CLAIM on the truncated pairs and hard-delete their
 * real finds. Over-claiming is the one direction this pipeline treats as
 * unrecoverable, so the answer decides whether the coverage claim can stay a
 * single date list or has to become per-pair.
 */
function describeSearch(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const withTrips = rows.filter((r) => Array.isArray(r.AvailabilityTrips) && r.AvailabilityTrips.length);
  const tripCount = withTrips.reduce((n, r) => n + r.AvailabilityTrips.length, 0);
  const pairOf = (r) => `${r.Route?.OriginAirport}-${r.Route?.DestinationAirport}`;
  const pairs = new Set(rows.map(pairOf));
  const sources = new Set(rows.map((r) => r.Source ?? r.Route?.Source));
  const sourcesWithTrips = new Set(withTrips.map((r) => r.Source ?? r.Route?.Source));
  const sample = withTrips[0]?.AvailabilityTrips?.[0] ?? null;

  // Global date monotonicity. A single out-of-order step is enough to disprove
  // "ordered by date across the whole response".
  const dates = rows.map((r) => r.Date ?? r.ParsedDate).filter(Boolean);
  let dateOrdered = true;
  for (let i = 1; i < dates.length; i++) if (dates[i] < dates[i - 1]) dateOrdered = false;

  // Per-pair spans. If the response is grouped, each pair occupies a contiguous
  // block and the pairs' date ranges will look independent rather than interleaved.
  const perPair = {};
  rows.forEach((r, i) => {
    const k = pairOf(r);
    const d = r.Date ?? r.ParsedDate;
    const p = (perPair[k] ??= { rows: 0, first: d, last: d, firstIndex: i, lastIndex: i });
    p.rows++;
    p.lastIndex = i;
    if (d) {
      if (!p.first || d < p.first) p.first = d;
      if (!p.last || d > p.last) p.last = d;
    }
  });
  // Contiguous blocks => grouped by pair. Interleaved => globally ordered.
  const contiguous = Object.values(perPair).every((p) => p.lastIndex - p.firstIndex + 1 === p.rows);
  const grouped = pairs.size > 1 && contiguous;

  return {
    rows: rows.length,
    count: body?.count,
    hasMore: body?.hasMore,
    cursor: body?.cursor,
    rowsWithTrips: withTrips.length,
    tripCount,
    pairs: [...pairs].sort(),
    perPair,
    dateOrdered,
    grouped,
    sources: [...sources].filter(Boolean).sort(),
    sourcesWithTrips: [...sourcesWithTrips].filter(Boolean).sort(),
    tripKeys: sample ? Object.keys(sample) : [],
    segmentKeys: Array.isArray(sample?.AvailabilitySegments)
      ? Object.keys(sample.AvailabilitySegments[0] ?? {})
      : [],
  };
}

function reportSearch(name, wire, shape) {
  const bytesPerRow = shape.rows ? Math.round(wire.text.length / shape.rows) : 0;
  console.log(`    rows ${shape.rows} (count ${shape.count}, hasMore ${shape.hasMore}, cursor ${shape.cursor})`);
  console.log(`    ${kb(wire.text.length)} total · ${bytesPerRow}B/row`);
  console.log(
    `    rows carrying trips: ${shape.rowsWithTrips}/${shape.rows}` +
      (shape.tripCount ? ` · ${shape.tripCount} trips · ${(shape.tripCount / Math.max(1, shape.rowsWithTrips)).toFixed(1)}/row` : ""),
  );
  console.log(`    pairs: ${shape.pairs.join(", ") || "none"}`);
  if (shape.pairs.length > 1) {
    for (const [pair, p] of Object.entries(shape.perPair)) {
      console.log(`      ${pair.padEnd(9)} ${String(p.rows).padStart(4)} rows · ${p.first}..${p.last} · idx ${p.firstIndex}-${p.lastIndex}`);
    }
    console.log(
      `    ORDERING: ${shape.dateOrdered ? "globally date-ordered" : "NOT globally date-ordered"}` +
        ` · ${shape.grouped ? "GROUPED BY PAIR" : "interleaved across pairs"}`,
    );
    if (shape.grouped || !shape.dateOrdered) {
      console.log(
        "    ⚠ the coverage claim CANNOT stay a single global date list. A truncated\n" +
          "      read would over-claim on the pairs it never reached and hard-delete\n" +
          "      their finds. coveredDates must become per-pair, and a pair with zero\n" +
          "      rows in a truncated response must claim NOTHING.",
      );
    }
  }
  console.log(`    sources: ${shape.sources.length} → ${shape.sources.join(", ") || "none"}`);
  if (shape.rowsWithTrips) {
    console.log(`    sources WITH trips: ${shape.sourcesWithTrips.length} → ${shape.sourcesWithTrips.join(", ")}`);
    console.log(`    trip keys: ${shape.tripKeys.join(", ")}`);
    console.log(`    segment keys: ${shape.segmentKeys.join(", ") || "! no AvailabilitySegments"}`);
  }
}

/**
 * The Worker's own limits, restated in the units this probe measures.
 *
 * A page is held in memory and a bounded slice of it is streamed to the tab
 * (`CAPTURE_BUDGET_BYTES` in api/src/search.ts). A variant that cannot
 * fit a page inside the whole capture budget is not a variant we can ship with
 * the current streaming design, whatever its shape looks like.
 */
const CAPTURE_BUDGET_BYTES = 6_000_000;

function verdict(results) {
  console.log("\n· verdict");
  const base = results.find((r) => r.name === "baseline");
  for (const r of results) {
    if (!r.ok) {
      console.log(`  ${r.name.padEnd(9)} FAILED http ${r.status}`);
      continue;
    }
    const growth = base?.bytes ? `${(r.bytes / base.bytes).toFixed(1)}x baseline` : "";
    const pagesInBudget = Math.floor(CAPTURE_BUDGET_BYTES / Math.max(1, r.bytes));
    console.log(
      `  ${r.name.padEnd(9)} ${kb(r.bytes).padStart(9)} ${growth.padStart(14)} · ` +
        `${r.shape.rowsWithTrips}/${r.shape.rows} rows detailed · ` +
        `${pagesInBudget} such pages fit the ${kb(CAPTURE_BUDGET_BYTES)} capture budget`,
    );
  }
  console.log(
    "\n  Reminder: include_trips costs no extra metered call. The question this\n" +
      "  answers is only whether the response fits the Worker, and whether every\n" +
      "  source populates trips or only some.",
  );
}

// --- ledger probes ---------------------------------------------------------

/** `GET /partnerapi/routes?source=X` is undocumented — it has been used here to
 *  validate source names, never captured. Its payload is the route graph a
 *  program claims to fly, so what it actually contains matters. */
async function probeRoutes(source, apiKey) {
  const url = `${BASE}/routes?source=${encodeURIComponent(source)}`;
  console.log(`\n· routes (${source})\n  GET ${url}`);
  const wire = await get(url, apiKey);
  let body;
  try {
    body = JSON.parse(wire.text);
  } catch {
    console.log(`    ! not JSON: ${wire.text.slice(0, 200)}`);
    return { url, wire, body: wire.text.slice(0, 2000) };
  }
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  console.log(`    top-level: ${Array.isArray(body) ? "array" : Object.keys(body).join(", ")}`);
  console.log(`    routes: ${Array.isArray(rows) ? rows.length : "not an array"}`);
  if (Array.isArray(rows) && rows[0]) {
    console.log(`    route[0] keys: ${Object.keys(rows[0]).join(", ")}`);
    console.log(`    route[0]: ${JSON.stringify(rows[0])}`);
  }
  return { url, wire, body };
}

/** Bulk Availability — "Retrieve a large amount of availability objects from one
 *  specific mileage program". Never probed here. One call, recorded for the
 *  ledger so a future argument about it starts from evidence. */
async function probeBulk(source, apiKey) {
  const url = `${BASE}/availability?source=${encodeURIComponent(source)}&take=100`;
  console.log(`\n· bulk availability (${source})\n  GET ${url}`);
  const wire = await get(url, apiKey);
  let body;
  try {
    body = JSON.parse(wire.text);
  } catch {
    console.log(`    ! not JSON: ${wire.text.slice(0, 200)}`);
    return { url, wire, body: wire.text.slice(0, 2000) };
  }
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  console.log(`    top-level: ${Array.isArray(body) ? "array" : Object.keys(body).join(", ")}`);
  console.log(`    rows: ${Array.isArray(rows) ? rows.length : "not an array"}`);
  if (Array.isArray(rows) && rows[0]) console.log(`    row[0] keys: ${Object.keys(rows[0]).join(", ")}`);
  return { url, wire, body };
}

// --- fixture ---------------------------------------------------------------

function writeFixture(args, stem, note, payload) {
  if (args["no-write"]) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = resolve(FIXTURE_DIR, `${stem}.json`);
  const serialized = JSON.stringify({ capturedAt: new Date().toISOString(), note, ...payload }, null, 2);
  writeFileSync(file, serialized + "\n");
  console.log(`\n    wrote ${file} (${kb(serialized.length)})`);
  console.log("    read it before committing — fixtures are committed forever.");
}

// --- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) usage();

  const apiKey = readApiKey();
  if (!apiKey) usage("no SEATS_AERO_API_KEY in the environment or in api/.dev.vars");

  const trim = Number(args.trim ?? 3);

  if (typeof args.routes === "string") {
    const { url, wire, body } = await probeRoutes(args.routes, apiKey);
    if (typeof args.out === "string") {
      writeFixture(args, args.out, `Real GET /partnerapi/routes?source=${args.routes}. Key redacted, arrays trimmed.`, {
        request: { url, method: "GET", headers: { "Partner-Authorization": REDACTED } },
        status: wire.status,
        headers: redactHeaders(wire.headers),
        body: trimDeep(body, trim),
      });
    }
    return;
  }

  if (typeof args.bulk === "string") {
    const { url, wire, body } = await probeBulk(args.bulk, apiKey);
    if (typeof args.out === "string") {
      writeFixture(args, args.out, `Real GET /partnerapi/availability?source=${args.bulk}. Key redacted, arrays trimmed.`, {
        request: { url, method: "GET", headers: { "Partner-Authorization": REDACTED } },
        status: wire.status,
        headers: redactHeaders(wire.headers),
        body: trimDeep(body, trim),
      });
    }
    return;
  }

  if (!args.from || !args.to) usage("pass --from and --to (comma-delimited lists are the point)");

  const wanted =
    typeof args.only === "string" ? VARIANTS.filter((v) => v.name === args.only) : VARIANTS;
  if (wanted.length === 0) usage(`unknown --only ${args.only}`);
  console.log(`\nspending ${wanted.length} call${wanted.length === 1 ? "" : "s"} of today's 1000.`);

  const results = [];
  let detailed = null; // the richest successful variant, for the fixture

  for (const variant of wanted) {
    const url = searchUrl(args, variant);
    console.log(`\n· ${variant.name}\n  GET ${url}`);
    const wire = await get(url, apiKey);
    if (!wire.ok) {
      console.log(`    ! ${wire.text.slice(0, 300)}`);
      results.push({ name: variant.name, ok: false, status: wire.status });
      continue;
    }
    let body;
    try {
      body = JSON.parse(wire.text);
    } catch {
      console.log(`    ! not JSON: ${wire.text.slice(0, 200)}`);
      results.push({ name: variant.name, ok: false, status: wire.status });
      continue;
    }
    const shape = describeSearch(body);
    reportSearch(variant.name, wire, shape);
    results.push({ name: variant.name, ok: true, status: wire.status, bytes: wire.text.length, shape });
    if (shape.rowsWithTrips && (!detailed || variant.name === "minified")) {
      detailed = { variant, url, wire, body, shape };
    }
  }

  verdict(results);

  if (!detailed) {
    console.log(
      "\n  No variant returned AvailabilityTrips. include_trips is accepted but\n" +
        "  unpopulated on this route — record that in docs/SEATS-AERO.md\n" +
        "  and keep /trips/{id} enrichment as the only path to real legs.",
    );
    return;
  }

  writeFixture(
    args,
    typeof args.out === "string" ? args.out : "seatsaero-search-trips",
    `Real GET /partnerapi/search with ${new URLSearchParams(detailed.variant.params)}. Key redacted, arrays trimmed.`,
    {
      request: {
        url: detailed.url,
        method: "GET",
        headers: { "Partner-Authorization": REDACTED, accept: "application/json" },
      },
      // The measurements, kept beside the payload: a trimmed fixture cannot be
      // re-measured, and the sizing is the reason this probe exists.
      measured: {
        variant: detailed.variant.name,
        bytes: detailed.wire.text.length,
        durationMs: detailed.wire.durationMs,
        ...detailed.shape,
      },
      status: detailed.wire.status,
      headers: redactHeaders(detailed.wire.headers),
      body: trimDeep(detailed.body, trim),
    },
  );
}

main().catch((err) => {
  console.error(`\n${err?.stack ?? err}`);
  process.exit(1);
});
