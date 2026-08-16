// Captures a real `GET /partnerapi/trips/{id}` response as a fixture.
//
//   node scripts/probe-seatsaero-trips.mjs --id 3BCXpWH00UESULY4MtkK8FMY5gE
//   node scripts/probe-seatsaero-trips.mjs --from SFO --to NRT --days 120
//
// WHY THIS EXISTS
// ---------------
// Nothing in this repo has ever called `/trips`. The search fixture beside the
// one this writes is hand-authored from the documented Cached Search shape, and
// that was affordable because `/search` is the endpoint the whole app already
// exercises live. `/trips` has no such backstop: its parser decides which real
// aeroplane a stored find describes, so writing it against a guessed payload is
// exactly the mistake `docs/SEATS-AERO.md` exists to prevent.
//
// WHAT IT COSTS
// -------------
// **One call** per `--id`, out of 1000 per UTC day — the same allowance Search
// spends. Passing `--from/--to` instead spends one extra call to find an id.
// The remaining allowance is printed after every request, read off the same
// `X-RateLimit-Remaining` header `parseQuotaHeaders` reads.
//
// Fixtures are committed forever, so the key is redacted and long arrays are
// trimmed. Read the file before committing it.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = resolve(ROOT, "shared/src/providers/__fixtures__");
const BASE = "https://seats.aero/partnerapi";
const REDACTED = "<redacted>";
const REQUEST_TIMEOUT_MS = 30_000;

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
usage: node scripts/probe-seatsaero-trips.mjs (--id <ksuid> | --from <IATA> --to <IATA>)

  --id <ksuid>       an Availability object's ID (1 call)
  --from/--to <IATA> find one via a search first (2 calls total)
  --days <n>         offset from today for the search (default 120)
  --source <name>    restrict the search to one seats.aero source, e.g. alaska
  --trim <n>         keep at most n elements per array (default 4)
  --raw              do not trim
  --out <stem>       fixture filename stem (default "seatsaero-trips")
  --no-write         probe and report, write nothing
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
    `  ${res.ok ? "✓" : "✗"} http ${res.status} · ${text.length}B · ${Date.now() - startedAt}ms` +
      (remaining != null ? ` · ${remaining} calls left today` : " · NO x-ratelimit-remaining header"),
  );
  return { status: res.status, ok: res.ok, headers, text };
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Spend one search call to find an availability id worth expanding. Prefers a
 *  row with business or first space, since those are the ones a person actually
 *  clicks Enrich on, and picks a connecting one where possible — a single-leg
 *  trip would not exercise the segment array. */
async function findAvailabilityId(args, apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const start = addDaysISO(today, Number(args.days ?? 120));
  const params = new URLSearchParams({
    origin_airport: String(args.from).toUpperCase(),
    destination_airport: String(args.to).toUpperCase(),
    start_date: start,
    end_date: addDaysISO(start, 30),
    take: "200",
  });
  if (typeof args.source === "string") params.set("sources", args.source);

  const url = `${BASE}/search?${params}`;
  console.log(`\n· search for an id\n  GET ${url}`);
  const wire = await get(url, apiKey);
  if (!wire.ok) throw new Error(`search failed: http ${wire.status}: ${wire.text.slice(0, 300)}`);

  const rows = JSON.parse(wire.text).data ?? [];
  if (rows.length === 0) throw new Error("search returned no rows — try a different route or --days");

  const score = (r) =>
    (r.JAvailable || r.FAvailable ? 2 : 0) + (r.JDirect === false || r.YDirect === false ? 1 : 0);
  const best = rows.filter((r) => r.ID).sort((a, b) => score(b) - score(a))[0];
  if (!best) throw new Error("no row carried an ID");
  console.log(
    `  picked ${best.ID} — ${best.Route?.OriginAirport}->${best.Route?.DestinationAirport} ` +
      `${best.Date} ${best.Source} (Y${best.YAvailable ? "✓" : "·"} W${best.WAvailable ? "✓" : "·"} ` +
      `J${best.JAvailable ? "✓" : "·"} F${best.FAvailable ? "✓" : "·"})`,
  );
  return { id: best.ID, availability: best };
}

// --- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) usage();

  const apiKey = readApiKey();
  if (!apiKey) usage("no SEATS_AERO_API_KEY in the environment or in api/.dev.vars");

  let id = typeof args.id === "string" ? args.id : null;
  let availability = null;
  if (!id) {
    if (!args.from || !args.to) usage("pass --id, or --from and --to to find one");
    ({ id, availability } = await findAvailabilityId(args, apiKey));
  }

  const url = `${BASE}/trips/${encodeURIComponent(id)}`;
  console.log(`\n· trips\n  GET ${url}`);
  const wire = await get(url, apiKey);

  let body;
  try {
    body = JSON.parse(wire.text);
  } catch {
    body = wire.text.slice(0, 4000);
  }

  // The whole point of the probe: report the shape rather than assume it.
  if (body && typeof body === "object") {
    console.log(`    top-level keys: ${Object.keys(body).join(", ")}`);
    const trips = Array.isArray(body) ? body : (body.data ?? []);
    console.log(`    trips: ${Array.isArray(trips) ? trips.length : "not an array"}`);
    const t = Array.isArray(trips) ? trips[0] : null;
    if (t) {
      console.log(`    trip[0] keys: ${Object.keys(t).join(", ")}`);
      const segs = t.AvailabilitySegments ?? t.Segments ?? t.segments;
      if (Array.isArray(segs) && segs[0]) {
        console.log(`    segment[0] keys: ${Object.keys(segs[0]).join(", ")}`);
      } else {
        console.log("    ! no segment array found under AvailabilitySegments/Segments/segments");
      }
      const cabins = [...new Set(trips.map((x) => x.Cabin ?? x.cabin))];
      console.log(`    cabins present: ${cabins.join(", ") || "none"}`);
    }
  }

  if (args["no-write"]) return;

  const trim = Number(args.trim ?? 4);
  const fixture = {
    capturedAt: new Date().toISOString(),
    note: args.raw
      ? "Real GET /partnerapi/trips/{id} capture, untrimmed. Key redacted."
      : "Real GET /partnerapi/trips/{id} capture. Key redacted, arrays trimmed.",
    request: {
      url,
      method: "GET",
      headers: { "Partner-Authorization": REDACTED, accept: "application/json" },
    },
    availabilityId: id,
    // Carried so the parser's tests can assert the trips agree with the
    // availability row they expand — the check that stops a stale or swapped
    // payload decorating the wrong find.
    availability: availability ? trimDeep(availability, trim) : undefined,
    status: wire.status,
    headers: redactHeaders(wire.headers),
    body: args.raw ? body : trimDeep(body, trim),
  };

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const stem = typeof args.out === "string" ? args.out : "seatsaero-trips";
  const file = resolve(FIXTURE_DIR, `${stem}.json`);
  const serialized = JSON.stringify(fixture, null, 2);
  writeFileSync(file, serialized + "\n");
  console.log(`\n    wrote ${file} (${serialized.length}B)`);
  console.log("    read it before committing — fixtures are committed forever.");
}

main().catch((err) => {
  console.error(`\n${err?.stack ?? err}`);
  process.exit(1);
});
