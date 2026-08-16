// The gather CLI. Runs the sources that must execute on this machine and pushes
// what they find to the API.
//
//   npm run gather -- --from SEA --to LAX --days 0-60
//   npm run gather -- --from SEA --to NRT --date 2026-11-05
//   npm run gather -- --route 3
//   npm run gather -- --from SEA --to LAX --days 0-30 --dry
//
// Only sources declaring `runtime: "local"` are eligible here; everything else
// runs on the Worker and is reached by pressing Search. Today that means this
// command drives PointsYeah and nothing else. See docs/SOURCES.md.
//
// Run through vite-node so `.js`-specifier-to-`.ts` imports resolve the same way
// they do under vitest.

import { hostname } from "node:os";
import { listSources, resolveRunnable, runnableSources, todayISO, type SourceQuery } from "@bertbooker/core";
import { loadEnv } from "./env.js";
import { makeIngestClient, type IngestClient } from "./ingest.js";
import { runSources, type RunEvent } from "./runner.js";

// Before anything reads process.env below. The shell still wins over .env.
loadEnv();

const VERSION = "0.1.0";

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const LOCAL_IDS = runnableSources("local").map((s) => s.id);

function usage(msg?: string): never {
  if (msg) console.error(`\nerror: ${msg}`);
  console.error(`
usage: npm run gather -- --from <IATA> --to <IATA> [--date <ISO> | --start <ISO> --end <ISO> | --days a-b]

  --from, --to       origin / destination IATA
  --route <id>       gather for a saved tracked route instead (overrides the above)
  --date <ISO>       single date
  --start, --end     inclusive date window
  --days a-b         window as day offsets from today, e.g. 0-60 (default 0-60)
  --programs a,b     restrict WHICH SOURCES run (not what gets stored)
  --sources a,b      source ids (default: every local source)
                     local: ${LOCAL_IDS.join(", ") || "(none)"}
                     worker-only (not runnable here): ${listSources({ runtime: "worker" }).map((s) => s.id).join(", ") || "(none)"}
  --dry              run everything, print results, write NOTHING
  --api <url>        API base (default $BERTBOOKER_API_URL or http://127.0.0.1:8787)
  --fast             no pacing delay between tasks. Local testing only.
  --json             emit raw JSON instead of a table
  --verbose          print every source log line, not just warnings

env: BERTBOOKER_API_URL, INGEST_TOKEN
     Read from the shell, or from a .env at the repo root (shell wins).
`);
  process.exit(msg ? 1 : 0);
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage();

const apiBase = String(args.api ?? process.env.BERTBOOKER_API_URL ?? "http://127.0.0.1:8787");
const today = todayISO();

// ---- what to gather ---------------------------------------------------------
let query: SourceQuery;
if (args.route) {
  query = await queryFromTrackedRoute(apiBase, Number(args.route));
  console.error(`route ${args.route}: ${query.origin} -> ${query.destination}`);
} else {
  if (!args.from || !args.to) usage("--from and --to are required (or --route <id>)");
  let dateStart: string;
  let dateEnd: string;
  if (args.date) {
    dateStart = dateEnd = String(args.date);
  } else if (args.start) {
    dateStart = String(args.start);
    dateEnd = String(args.end ?? args.start);
  } else {
    // Default window is short because the only local source has a ~70-day
    // horizon; asking for a year would plan one task and clamp it anyway.
    const [lo, hi] = String(args.days ?? "0-60")
      .split("-")
      .map(Number);
    dateStart = addDays(today, lo ?? 0);
    dateEnd = addDays(today, hi ?? lo ?? 60);
  }
  query = {
    origin: String(args.from).toUpperCase(),
    destination: String(args.to).toUpperCase(),
    dateStart,
    dateEnd,
    programs: args.programs ? String(args.programs).split(",") : undefined,
  };
}

// An unknown id, or one that belongs to the Worker, is operator error rather
// than a crash. Both throw here, before a run is opened, so nothing is recorded
// as `failed` for a reason that was knowable a second earlier.
const sourceIds = args.sources ? String(args.sources).split(",") : LOCAL_IDS;
let sources;
try {
  sources = resolveRunnable(sourceIds, "local");
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}
if (!sources.length) usage("no local sources registered — nothing to run");

// ---- where it goes ----------------------------------------------------------
const collected: unknown[] = [];
const ingest: IngestClient = args.dry
  ? {
      // A dry run must still exercise the real code path — plan, execute,
      // classify, batch — or it isn't testing the thing that breaks. Only the
      // three HTTP calls are stubbed.
      open: async () => {},
      push: async (_runId, batch) => {
        for (const t of batch.tasks) collected.push(...t.offers);
      },
      finish: async () => {},
    }
  : makeIngestClient({ baseUrl: apiBase, token: process.env.INGEST_TOKEN });

const runId = crypto.randomUUID();
console.error(
  `${query.origin} -> ${query.destination}  ${query.dateStart}..${query.dateEnd}\n` +
    `  sources ${sourceIds.join(", ")}\n` +
    `  ${args.dry ? "DRY RUN — nothing will be written" : `ingest ${apiBase}  run ${runId}`}\n`,
);

// Ctrl-C should end the run cleanly — flushing what it has and marking the run
// `aborted` — rather than leaving it `running` forever.
const abort = new AbortController();
process.on("SIGINT", () => {
  console.error("\ninterrupted — finishing the current task and flushing…");
  abort.abort();
});

const result = await runSources({
  runId,
  query,
  sources,
  ingest,
  today,
  host: hostname(),
  version: VERSION,
  signal: abort.signal,
  pacing: args.fast ? { minMs: 0, maxMs: 0 } : undefined,
  onEvent: printEvent,
});

console.error(
  `\n${result.status.toUpperCase()}  ${result.tasksOk}/${result.tasksPlanned} tasks ok, ` +
    `${result.offersFound} offer(s), ${(result.durationMs / 1000).toFixed(1)}s`,
);
for (const [id, s] of Object.entries(result.perSource)) {
  console.error(`  ${id.padEnd(24)} ok ${s.ok}  failed ${s.failed}  offers ${s.offers}`);
}

if (args.dry) printDryResults();
// A run that stored nothing because every source was refused must not exit 0 —
// a green exit code on an empty gather is exactly the silent failure this whole
// architecture exists to prevent.
process.exit(result.status === "failed" ? 1 : 0);

// -----------------------------------------------------------------------------

function printEvent(e: RunEvent): void {
  switch (e.type) {
    case "run_start":
      console.error(`planned ${e.tasksPlanned} task(s) across ${e.sources.length} source(s)`);
      break;
    case "source_skipped":
      console.error(`  – ${e.source}: ${e.reason}`);
      break;
    case "task_done": {
      const mark = { ok: "✓", empty: "·", skipped: "–" }[e.status as string] ?? "✗";
      console.error(
        `  ${mark} ${e.taskKey.padEnd(46)} ${e.status.padEnd(11)} ` +
          `${String(e.offersFound).padStart(3)} offers  ${String(e.durationMs).padStart(6)}ms` +
          (e.error ? `  ${e.error.slice(0, 90)}` : ""),
      );
      break;
    }
    case "log":
      if (e.line.level !== "info" || args.verbose) console.error(`    · ${e.line.message}`);
      break;
    default:
      break;
  }
}

function printDryResults(): void {
  const offers = collected as {
    flightDate: string;
    cabin: string;
    program: string;
    milesCost: number;
    cashFeesCents: number;
    cashPriceCents?: number;
    seatsAvailable: number;
    stops?: number;
    segments: { carrier: string; flightNumber?: string }[];
    bookableWith?: string[];
  }[];

  if (args.json) {
    console.log(JSON.stringify(offers, null, 2));
    return;
  }
  if (offers.length === 0) {
    // Empty is usually the window or the route, not a bug. Cheapest checks first.
    console.error(
      `\n0 offers. Not necessarily a bug — check in order:\n` +
        `  1. Do these programs actually fly ${query.origin}-${query.destination} on these dates?\n` +
        `  2. Is the window inside each source's horizon? (see the 'nothing in horizon' lines above)\n` +
        `  3. Any task status other than ok/empty above means we never got an answer.`,
    );
    return;
  }
  console.log(
    `\n${offers.length} offer(s)\n` +
      `${"date".padEnd(12)}${"program".padEnd(12)}${"cabin".padEnd(10)}${"miles".padStart(8)}  ` +
      `${"fees".padStart(8)}  ${"cash".padStart(9)}  ${"seats".padStart(5)}  stops  itinerary`,
  );
  for (const r of offers.sort((a, b) => a.flightDate.localeCompare(b.flightDate))) {
    const itin = r.segments.map((s) => `${s.carrier}${s.flightNumber ?? ""}`).join(">");
    // "—" means no source could see a revenue fare for this itinerary, which is
    // different from it being free. Distinct from `fees` (award taxes).
    const cash = r.cashPriceCents == null ? "—" : `$${(r.cashPriceCents / 100).toFixed(2)}`;
    console.log(
      `${r.flightDate.padEnd(12)}${r.program.padEnd(12)}${r.cabin.padEnd(10)}` +
        `${String(r.milesCost).padStart(8)}  ${(r.cashFeesCents / 100).toFixed(2).padStart(8)}  ` +
        `${cash.padStart(9)}  ${String(r.seatsAvailable).padStart(5)}  ` +
        `${String(r.stops ?? "?").padStart(5)}  ${itin}  [${r.bookableWith?.join(",") ?? ""}]`,
    );
  }
}

async function queryFromTrackedRoute(base: string, id: number): Promise<SourceQuery> {
  const res = await fetch(`${base.replace(/\/$/, "")}/api/tracked-routes`);
  if (!res.ok) usage(`could not read tracked routes: HTTP ${res.status}`);
  const routes = (await res.json()) as Record<string, unknown>[];
  const row = routes.find((r) => Number(r.id) === id);
  if (!row) usage(`no tracked route with id ${id}`);
  return {
    origin: String(row.origin),
    destination: String(row.destination),
    dateStart: String(row.date_start),
    dateEnd: String(row.date_end),
    // A route's `programs` narrows which sources are worth running. Its cabin,
    // currency and min-seat filters are deliberately NOT applied: they are
    // display preferences, and gathering to them would bake one route's taste
    // into shared data.
    programs: row.programs ? (JSON.parse(String(row.programs)) as string[]) : undefined,
  };
}
