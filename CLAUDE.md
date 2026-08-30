# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

CRITICAL: Write zero comments unless explaining non-obvious 'why' logic". Use an active voice, no stage performances, and pick the most common word when choosing among alternatives. When changing existing code, NEVER leave comments explaining how it used to be. When writing comments, the audience is someone reading this code in the future for the first time. NEVER document any invariants that you haven't cleared with the user first. Assuming invariants incorrectly poisons future sessions and snowballs.

**What belongs in this file:** what you need *before* you know which file to
open. Once you are in a file, its header comment is the authority and it is kept
fuller than this — `apply.ts`, `finds.ts`, `themes.ts`, `router.tsx` and their
neighbours all carry their own reasoning at the line it constrains. Don't copy
that reasoning back up here; a second copy is a second thing to drift.

## What this is

**BertBooker** — a private, self-hosted award-travel availability tracker (a
personal seats.aero) for two users. A live view of monitored routes and a
browsable flight database, each result tagged with which of the couple's cards
can book it (Chase / Capital One / Bilt / Citi / Amex).

**There is ONE source and ONE place code runs.** Pressing Search on a tracked
route makes the Worker call the seats.aero **Partner API**, streaming progress
back per 90-day chunk. Everything reaches the database through one ingest
pipeline (`applyTask`); the app then *queries the database* it filled.

Two other writers exist and neither changes that sentence. **Enrich**
(`search/enrich.ts`) buys the itinerary behind a row on a click — it claims no
coverage and prunes nothing. **Alerts** (`api/src/alerts/`) is a Cron Trigger
re-running the same Search engine (`search/run.ts`, two callers and one
behaviour) with nobody pressing a button.

**The Worker reaches exactly three hosts, and the split is the rule rather than an
exception list:** inbound data — **seats.aero**, allowed because it is a keyed
vendor API that authenticates the *key*, not the client; outbound notification —
**Resend**, a delivery channel rather than a data source; observability about
ourselves — **Cloudflare's GraphQL Analytics API**, asked what our own D1
queries have cost today so the app bar can show it (`providers/cloudflareAnalytics.ts`).
The test is who is being scored: a service may authenticate the **credential**,
and may not judge the **client**. Carriers do the latter and refuse datacenter
IPs — United with an Akamai `428`, Delta with a `444` that survives a real
browser session replayed verbatim. **If you are adding a `fetch` to an airline in
`api`, stop.** A source that fails this test does not get added; there is no
local-execution escape hatch for it.

The third host was added deliberately, and the reasoning is in `wrangler.toml`
beside the list: it passes the credential test, it is neither a data source nor a
delivery channel, its token is scoped `Account Analytics: Read` and can change
nothing, and unset it costs only two chips. **This is not a precedent for a
fourth.** The categories are the rule; a host that fits none of them still has to
argue its way in.

Two rules out of `docs/ALERTS.md` constrain code elsewhere:

- **Unattended work must never fail invisibly.** No email is sent when a sweep
  breaks — only when it finds something — so the Alerts tab and Workers Logs are
  the entire safety net.
- **Only `alerts/budget.ts` reads the quota before spending.** Interactive paths
  spend first and report after; do not add a budget guard anywhere else.

### The docs own the depth

Each is the *only* place its subject is written down. Read the relevant one
before touching the code it covers — none of it is repeated here.

| Doc | Owns | Read before touching |
| --- | --- | --- |
| `docs/SOURCES.md` | the source contract: what a source is, what may be added, the three ingest rules, how to add one | `api/src/sources`, `api/src/ingest` |
| `docs/SEATS-AERO.md` | the whole Partner API integration — endpoints, call economics, payload traps, coverage, enrichment, quota. §12 is the route graph and connections | `endpoints/search.ts`, `api/src/search/`, `providers/seatsaero.ts` |
| `docs/ALERTS.md` | the whole scheduled sweep — why a cron at all, the pacing model, the CPU limit and per-tick call cap, the budget guard, the outbox, the digest | `api/src/alerts`, the cron in `wrangler.toml` |
| `docs/UI-TESTING.md` | running and looking at the SPA with nobody at the keyboard — the headless harness, session seeding, what it must never touch | `e2e/` |

## Commands

```sh
npm install                 # ONE package.json at the root. No workspaces.

# Local D1 (--persist-to .wrangler-local, wired into the dev script):
npx wrangler d1 create bertbooker_db   # then paste id into api/wrangler.toml
npm run db:apply:local      # apply migrations/  (schema only)
npm run db:seed:local       # seed/programs.sql (idempotent, re-runnable)

# Run locally (127.0.0.1 for the API, localhost for Vite — see Local dev):
                            # api/.dev.vars (gitignored) is the ONLY env file and
                            # needs four lines:
                            #   SEATS_AERO_API_KEY=…   what Search spends
                            #   APP_PASSWORD=…         the shared password; UNSET => every
                            #                          /api/* route answers 503, on purpose
                            #   SESSION_SECRET=…       32 random bytes (base64url) signing the
                            #                          session cookie; UNSET => 503 as well
                            #   APP_USER_EMAIL=…       the single shared identity; UNSET =>
                            #                          `identity` 401s every route and the
                            #                          cron fails closed
npm run dev:api             # Hono API → 127.0.0.1:8787 (clears a wedged port first)
npm run dev:app             # Vite SPA → localhost:5173 (proxies /api → :8787)
npm run dev:api:stop        # when Ctrl+C left workerd behind — see Local dev

# There is no gather step. All gathering happens inside the Worker, driven by
# pressing Search or by the cron. The ladder for adding a source is in
# docs/SOURCES.md. Do not guess a payload.

npm run probe:seatsaero-trips -- --from SFO --to NRT --days 120
npm run probe:seatsaero-search -- --from SFO,OAK --to NRT,HND --days 120
                            # BOTH SPEND METERED CALLS — see docs/SEATS-AERO.md
                            # before running either.

# Airport reference data (~72k rows, public-domain OurAirports):
npm run build:airports          # regenerates seed/airports.sql (needs internet).
                                # FAILS if upstream ships a duplicate IATA code —
                                # resolve it, don't bypass it (airports.iata is
                                # UNIQUE, and this script is what enforces it).
npm run db:seed:airports:local  # loads the table AND rebuilds what is derived
                                # from it. Both halves, always — never run
                                # seed/airports.sql on its own (see Generated files).
npm run build:world             # regenerates app/src/data/worldGeometry.ts, the
                                # basemap the route maps draw (needs internet)

npm test                    # ONE vitest run over shared/, api/ and app/ (vitest.config.ts)
                            # — offline, no servers, no browser
npm run typecheck           # five tsc projects: shared, shared/wire, api, app, e2e

# Seeing the app. HEADLESS: no window opens, so a run cannot be disturbed by —
# or disturb — whoever is using the machine. Reuses dev:api/dev:app if they are
# already up and starts them if not, killing neither. docs/UI-TESTING.md first.
npm run test:ui             # the browser suite (e2e/*.spec.ts)
npm run ui:shot -- --path /library --theme review
                            # ad-hoc: go there, screenshot it, in named themes.
                            # `-- --help` lists the flags and every theme id.
                            # `--width 390 --height 844` is the phone; a
                            # non-default width is stamped into the filename, so
                            # it cannot overwrite its desktop twin.
                            # NEVER pass --show (or `playwright test --headed`,
                            # `--ui`, `--debug`, `show-report`): all open a window.
npm run deploy              # ONE artifact: vite build → wrangler deploy, which
                            # uploads the worker AND app/dist as its assets
```

Single test file / test: `npx vitest run api/src/providers/seatsaero.test.ts`
(`-t "<name>"` to filter). Tests live next to sources as `*.test.ts`.

## Layout

Deployed as **one worker** serving both the API and the SPA at `bertbooker.com`
(`www` 308s to the apex, so exactly one origin is ever served). Production is
gated by the shared-password gate (`middleware/gate.ts`) and nothing else —
there is no Cloudflare Access in front of it, so `APP_USER_EMAIL` is the single
shared identity everyone who knows the password signs in as.

**Three directories, one `package.json`, no workspaces and no path aliases.**
`api/` and `app/` both cross into `shared/` with plain relative specifiers
(`../../shared/src/wire/index.js`), which resolve identically in `tsc`,
wrangler's esbuild, Vite and vitest — which is why no alias is configured
anywhere.

- **`shared/`** — `src/wire/` (the API contract) and `src/match/` (the one
  route-matching predicate, run by BOTH the Worker and the SPA, and the only
  runtime code here). **Not a package** — no
  `package.json`, no `exports` map, nothing emitted.
- **`api/`** — the only worker, and its `wrangler.toml`. Identity is
  `APP_USER_EMAIL`; it *deliberately ignores*
  `Cf-Access-Authenticated-User-Email`, which with no Access in front is a
  string the client picked. The password session is the only credential.
- **`app/`** — the SPA and its `vite.config.ts`. Four pages: Routes, Alerts,
  Library (reference data, five tabs of catalogue), Tools (the working surface
  over the seats.aero route graph, three tabs, and the only page besides Routes
  that can spend a metered call). **Both multi-tab pages' sections are ROUTES,
  not state** — `/library/airports`, `/tools/coverage` — so a section is
  linkable, survives a reload and answers the back button. The bare paths
  redirect (`replace: true`) to their first section, so neither is ever a blank
  pane.

### The wire contract

**`shared/src/wire/` is the one definition of every API request and response**,
read by the Worker that produces it and the SPA that consumes it. It is also the
whole of `shared/`, which is what makes "the SPA imports the wire contract" a
fact about the tree rather than a rule with an exception list. Three rules:

- **The SPA imports `shared/`, never `api/`.** The import happens in
  `app/src/api/*`, which re-exports the types so no page or component names a
  path in `shared/`.
- **Every wire declaration is DECLARED in `wire/`, not borrowed from elsewhere.**
  Modules there import only each other; the backend module re-exports the
  declaration, so `api/` imports its own domain vocabulary from
  `api/src/domain/*`.
- **The Worker is annotated against it** — `const body: T = {…}` on hand-built
  literals, `.all<T>()` on D1 reads. That is what turns the types from
  documentation into a guarantee. Note the honest limit: **`.all<T>()` is an
  unchecked assertion**, not validation. Nothing compares `T` against the SQL
  column list, so each row type in `wire/rows.ts` names the statement it asserts
  about and that comment is the only thing keeping the two honest.

`shared/tsconfig.wire.json` enforces the first two. It is the narrowest project
in the repo — no DOM, no `@cloudflare/workers-types` — and the only pass that
catches a wire file reaching `fetch`/`Response`. This isn't theoretical: a
single type imported from a Worker-only file is enough to drag the whole
1361-line `providers/seatsaero.ts` into the SPA's bundle. `shared/tsconfig.json`
then checks the same files a second time *with* DOM and workers-types: that pass
proves they compose with the Worker's code, the narrow one proves they need none
of it.

### Inside `api/src/`

Grouped by **responsibility class** — HTTP surface / impure engine / isolated
policy.

| | |
| --- | --- |
| `index.ts` | **the composition root, and nothing else.** The middleware chain, the mounts, and the `fetch`/`scheduled` export. A new handler does not go here. |
| `bindings.ts` | `Env` and `Vars`. Every secret is documented on the field, including what its absence does. |
| `middleware/` | the request pipeline: `gate.ts` (password + `/api/auth/*`), `identity.ts`, `security.ts`. |
| `endpoints/` | one `Hono` sub-app per surface, registering **absolute** `/api/...` paths, so every mount in `index.ts` is at `"/"` and the path is greppable from the handler. **Named `endpoints/`, not `routes/`** — "route" already means a tracked route here. |
| `db/` | SQL more than one surface shares: `finds.ts` (the one `findsCte`) and `runs.ts`. |
| `search/` | the gathering engine — `run.ts` (plan/open/run) and `enrich.ts`, split from their HTTP shell because there are two callers and one behaviour. |
| `alerts/` | the scheduled sweep, pure halves included: `sweep.ts`, `budget.ts`, `pace.ts`, `select.ts`, `digest.ts`, `email.ts`. |
| `domain/` | the source-agnostic model: `types.ts`, `diff.ts`, `collapse.ts`, `routing.ts`, `graphPaths.ts`, and the reference seeds `programs.ts` / `airlines.ts`. |
| `ingest/`, `sources/`, `providers/` | the write pipeline, the source contract and registry, and the seats.aero integration. |

**The mount order in `index.ts` is the routing table.** Hono runs matching
handlers in registration order and stops at the first that responds, so
`endpoints/search.ts` and `endpoints/enrich.ts` — which own
`POST /api/tracked-routes/:id/search` and `/enrich` — must stay mounted ahead of
`endpoints/trackedRoutes.ts`, which owns `PATCH`/`DELETE` on
`/api/tracked-routes/:id`. `GET /api/health` and `/api/auth/*` are registered
*before* the gate, which is the only reason login is reachable — move that line
below the gate and you would need the password to ask for the password.

### Inside `app/src/`

The rule for each directory is about *who is allowed to import it*.

| | |
| --- | --- |
| `main.tsx`, `router.tsx`, `index.css` | the entry points. The shell wires pages together and owns nothing else — it takes the Routes page's URL contract from `pages/routes/searchParams.ts` rather than declaring it. |
| `api/` | **the one boundary crossing.** See *The wire contract*. |
| `lib/` | pure logic, no JSX, no React. **`lib/` is where a thing goes when it wants a test**, because `vitest.config.ts` globs `*.test.ts` only — a `*.test.tsx` is not skipped, it is silently never collected, and the run stays green. |
| `hooks/` | shared React hooks — the two named viewport seams, the airport-name lookup, the debounce. |
| `components/` | presentation used by more than one page. |
| `pages/<page>/` | **page-private, co-located with its only consumer.** A helper that ends up serving two pages leaves `pages/` for `components/` — `SectionHeader` and `TransferCurrencies` both made that trip. |
| `theme/` | `themes.ts` is the palette catalog, `build.ts` is the only place the app's shape is decided. |
| `data/` | **generated, and path-pinned** — `scripts/build-world-geometry.mjs` writes `worldGeometry.ts` by that exact path. Do not move this directory. |

**The shell pads nothing and scrolls nothing; each page owns both.** `Layout`
(`router.tsx`) is a fixed-height flex column and the document never scrolls.
Pages that are DOCUMENTS wrap themselves in `PagePad`, which supplies the page
margin and is their scroll container. The Routes page does not: it is a
workbench, a full-height sidebar beside an editor pane, each with its own
`overflow` from `md` up. The panes are told apart by GROUND, not by a gap.

**The app has TWO named viewport seams and no other media queries** (`useIsPhone`
= below `sm`, `useIsNarrow` = below `md`). Prefer an `sx` breakpoint object;
reach for a hook only when the **DOM** has to change, which is a smaller set than
it looks — three places today, and it was four until `SectionNav` replaced a
`Tabs orientation` prop with plain flex. That is the direction this should always
move.

**A theme is a palette, not a stylesheet.** Adding a theme is adding a
`ThemeSpec` to `themes.ts` and nothing else; no theme can restyle a component.
The palettes are **ported from BertBrowser**, a separate private project of the
author's — that source is not public, so treat the specs here as the record
rather than eyeballing a new colour. `themes.ts` and `build.ts` carry the rest,
including the two traps that are easy to undo by accident (`accent` is a GROUND,
not ink; interaction states are stated, not derived).

## Rules that hold across files

These constrain code anywhere, or span files with no single owner. Everything
else lives at its point of use — see *Where the depth lives*.

- **`.js` import specifiers resolve to `.ts`.** `shared/` and `api/` use ESM
  `./foo.js` imports pointing at `foo.ts`, and both `api/` and `app/` reach
  `shared/` the same way. esbuild (wrangler) and Vite (vitest) rewrite the
  extension. Keep the `.js` suffix on relative imports.
- **There is no barrel in `api/src/`, and that is deliberate.** A barrel that
  re-exports the whole domain hides which subsystem an imported symbol comes
  from. Imports name the owning module (`../providers/seatsaero.js`,
  `../domain/routing.js`). Don't reintroduce one.
- **`api/src/index.ts` imports `./sources/index.js` for its SIDE EFFECT**, and
  that line is the whole of a real check: `registerSource` validates every
  program the source declares against `PROGRAM_SEEDS` at module scope, and
  `availability_snapshots.program` is a foreign key, so without it a typo
  surfaces as a write failing mid-search instead of as a worker that won't boot.
  Nothing imports a *symbol* from `sources/`, so it looks removable. It is not.
- **`SearchKind` vs `ProgramKind`** (`domain/types.ts`): a *search* is
  `flight | hotel`; a *program* is `airline | hotel`. Different types — don't
  conflate them.
- **Ingest order is the safety property**: read baseline → write changed
  snapshots → prune. **Coverage is a claim, not a table** — `coverageSlices()`
  computes it in memory before any write and `prunable()` is its only consumer,
  so a crash under-claims rather than over-claims. Only `ok` and `empty` claim
  coverage (`COVERAGE_CLAIMING_STATUSES`), and `coveredDates` is read off the
  payload, never off the plan — sites clamp windows near today and near their horizon, and
  over-claiming hard-deletes real finds while under-claiming costs a stale row.
  When unsure, narrow it. `ingest/apply.ts` explains each clause;
  `docs/SOURCES.md` is the contract.
- **`availability_snapshots` holds ONE ROW PER SLOT** — `UNIQUE (route_key,
  program, cabin)` since `0014`, written by UPSERT and pruned by that same key.
  It was append-on-change history until then, and nothing ever read it as a
  series: every reader collapsed it away with `MAX(captured_at)`, which cost 57%
  of the Routes page query. `price_history` is the series, and holds strictly
  more — it survives the prune, so it records the disappearances snapshots
  cannot express. **`source` is no longer part of the key**, so a second source
  is a schema change rather than a config change; that trade is argued in `0014`.
- **`findsCte` is the one read of a stored find**, so no two surfaces can
  disagree about what a current find is, and **`shared/src/match/routeMatch.ts`
  is the one answer to "does this find belong to this route"** — the Routes page
  and the alert sweep run the same predicate, because an alert that fires on a
  find the route's pane hides is indistinguishable from a bug in either half,
  and the sweep sends no mail when it finds nothing so the other direction
  reports itself to nobody. That predicate was SQL until its `json_each` join
  became 57% of the page query. **`routeFindsScope` must stay a superset of
  `routeMatcher`** — that is the whole contract, and the only way to break it is
  to constrain a column here harder than the matcher constrains it. The scope is
  **one OR-group per route**, carrying that route's own airports, window and read
  filters, and it degrades in rungs when D1's 100-bind limit bites: per route,
  then the union of every route (filters dropped), then unscoped. It was limited
  to `origin`, `destination` and `flight_date` while a collapse ran underneath
  it; `0014` removed the collapse and the limit went with it. `db/finds.ts` has
  the why; `finds.test.ts` runs both engines against each other on `node:sqlite`
  rather than re-implementing either.
- **D1 bills rows READ, including temp b-tree and sort rows.** The only reliable
  lever is a `WHERE` that scans fewer base rows. **Measure, don't reason from the
  query's shape** — rewriting `per_source` as a `ROW_NUMBER()` window measured
  *worse* (38,637 vs 22,835) and `MATERIALIZED` did not recover it. The app bar's
  two arrow chips are the first place to look — today's rows read and written
  against the daily ceiling, account-wide, from Cloudflare's own analytics
  (`endpoints/d1Usage.ts`). They report and never enforce, and they are blind
  without `CLOUDFLARE_API_TOKEN`, so the per-query attribution is still
  `wrangler d1 execute --remote --json`'s `meta.rows_read` and
  `wrangler d1 insights`.
- **D1 allows 100 bound parameters per query, not SQLite's 999**, and 1,000
  queries per Worker invocation with batch statements counting. A bulk writer
  binds a chunk as ONE JSON parameter and expands it with `json_each`
  (`db/routeGraph.ts`) rather than a multi-row `VALUES`.
- **Migrations are one-time and tracked; never edit an applied one.**
  `0001_init.sql` is the record of what was APPLIED, **not a description of the
  live schema** — it still creates objects that later migrations drop, annotated
  `DROPPED BY 000N` in place. Annotate, don't delete, or a fresh database and a
  migrated one stop agreeing. The next number is one past the highest in
  `migrations/`.
- **Retiring a source is a migration, not just a deletion.** Prunes are scoped
  per source, so deleting a source's code leaves nothing with the authority to
  clean up its rows and they read as current forever.
  `migrations/0002_drop_pointsyeah.sql` is that cleanup, already applied.
- **A WHOLE-DATABASE `wrangler d1 export` does not work here** — D1 refuses to
  export a database containing virtual tables and `airports_fts` is one. **A
  table-scoped one does**, and it is the backup to take before any destructive
  migration:

      npx wrangler d1 export bertbooker_db --remote --config api/wrangler.toml         --table availability_snapshots --output ./backup.sql

  `wrangler d1 time-travel info` prints a bookmark that restores the whole
  database, and is the other half of the same insurance. To export EVERYTHING,
  drop `airports_fts`, export, then re-create it from `0006` and re-run
  `db:seed:airports:derived:*`.
- **Three paths spend real money** — search, enrich, and
  `POST /api/seatsaero/sources/:source/fetch`. All three are listed in
  `METERED_PATTERNS` (`e2e/fixtures.ts`) so a UI test that reaches one fails
  rather than quietly spending a call. `docs/SEATS-AERO.md` §12 has the guards
  around the third, which is reachable by *picking a program nobody has fetched
  yet* as well as by a button — which is why no spec may touch the source
  dropdown's options, and why `/tools/coverage` has to stay free to open.
- **Two things stream NDJSON** — the Worker's search and its enrich-all — and
  both hold the same rule: a stream ending without a terminal frame is a
  **failure**, never an empty result. Search has **three** terminal frames, not
  two: `run_done`, `error`, and `run_continue`. `readNdjson` is shared; the
  terminal-frame check belongs to each caller. Relatedly, **the Worker does
  everything fallible BEFORE opening a stream** — once the first byte is written
  the response is committed to 200 and the only way left to report a problem is
  an `error` frame, so a missing `SEATS_AERO_API_KEY` is a **503**, never an
  empty result that would read as "no award space".

### Generated files — do not hand-edit

| File | Regenerate with |
| --- | --- |
| `seed/airports.sql` | `npm run build:airports` |
| `seed/airports_derived.sql` | same — it is the `airports_fts` index |
| `app/src/data/worldGeometry.ts` | `npm run build:world` |

Two cross-file sync rules ride with them:

- **`seed/airports_derived.sql` must run after `seed/airports.sql`, always.**
  The first file does `DELETE FROM airports` and re-inserts every row, changing
  every rowid — and `airports_fts` is an EXTERNAL-CONTENT index keyed on exactly
  those rowids, so a skipped rebuild makes the autocomplete return whichever
  airport now occupies a matched row. Silent, not loud. The
  `db:seed:airports:local` / `:remote` scripts chain both halves and are the only
  launch path; running `seed/airports.sql` through wrangler by hand is how you
  get this wrong.
- **`seed/programs.sql` mirrors `api/src/domain/programs.ts`** — keep them in
  sync when adding or editing a program. The seed lives OUTSIDE `migrations/` so
  it stays re-runnable.

## Local dev, when it breaks

- **Addressing differs per server, and both are right.** Wrangler binds IPv4, so
  use `127.0.0.1:8787` (`localhost` → IPv6 `::1` hangs). Vite binds IPv6, so use
  `localhost:5173` (`127.0.0.1` is refused).
- **"The API hangs" is always a wedged port, never the code.** Two `wrangler dev`
  processes bind :8787 — Windows allows it — so connections split between a live
  worker and a dead one: the socket accepts, nothing answers, and the SPA shows
  pending spinners with **nothing in the network tab or console**. Killing
  `workerd` alone doesn't help; an orphaned wrangler parent respawns it.
  `npm run dev:api:stop` tears a leftover down by hand, and the same sweep runs
  as `predev:api` so a wedge can't survive into the next start.
- **`dev:api` goes through `scripts/dev-api.mjs`, which is what stops leftovers
  being made.** It launches wrangler's CLI directly rather than through
  `node_modules/wrangler/bin/wrangler.js`, whose `SIGINT` handler calls
  `.kill()` on the CLI — a SIGTERM on POSIX, but `TerminateProcess` on Windows,
  which hard-kills the CLI mid-shutdown and orphans the `workerd` it owned.
  Ctrl+C now reaches the CLI itself and it closes its own port. If it doesn't,
  the supervisor escalates to a tree kill and then to the `free-port` sweep, and
  `scripts/dev-watchdog.mjs` — detached, so it survives what it watches for —
  releases the port if the supervisor is killed outright with no handler able to
  run. Measured: hard-killing the shell under the old launcher left two `node`
  and two `workerd` processes holding :8787; under this one, nothing.
- **What is still not covered**, deliberately: kill the *shell* and leave the
  supervisor alive and the dev server keeps running, healthy, holding the port —
  it answers `200` on `/api/health`. That is a stray server, not a wedge, and
  `predev:api` clears it on the next start.
- **`api/.dev.vars` is the only environment file**, and it sits beside the
  `wrangler.toml` that loads it. Putting `APP_PASSWORD` anywhere else sets it for
  nobody — workerd only reads this file — and a definitely-correct password gets
  rejected as `bad_password`. Production's copies are `wrangler secret put`.
- **`wrangler dev` does not reload `.dev.vars`.** Editing a secret and watching
  the old value still work is not a caching bug in the gate — restart the API.
- **`identity` refuses everything when `APP_USER_EMAIL` is unset**, and the
  symptom is every page rendering its shell over a wall of `401 unauthenticated`
  — not a password prompt, because the gate already passed. It is required in
  `api/.dev.vars` for local dev, not just in production.
- **The local D1 lives under `--persist-to .wrangler-local`** (repo root). Every
  script that touches it — `dev:api` and all the `db:*` ones — runs wrangler from
  the root with `--config api/wrangler.toml`; change one without the others and
  you orphan the database.
- **Vite proxies exactly one prefix, `/api`, and a second one is a trap.** A
  proxy prefix that shadows a client route makes that page unreachable. Check any
  new prefix against `routeTree` in `app/src/router.tsx` first.

## Where the depth lives

Each subject below is fully explained in its own header comment, at the line it
constrains. When you touch the file, read it there.

| Subject | Owner |
| --- | --- |
| write-on-change, the stored-vs-recomputed baseline hash, why `collapseBy` is required, co-terminal answers and `routesTouched` | `api/src/ingest/apply.ts` |
| what claims coverage, and what a task may report | `api/src/ingest/types.ts`, `api/src/sources/types.ts` |
| the `findsCte` shape, and why a scope may constrain only the three columns that *are* `route_key` | `api/src/db/finds.ts` |
| what makes a find belong to a route, and the three places it differs from the SQL it replaced | `shared/src/match/routeMatch.ts` |
| why the snapshot table is current-only, and what the unique key costs | `migrations/0013`, `migrations/0014` |
| hub routes planning two seats.aero queries per date chunk, chunk-major task order, `autoVia`, `splitDirectAndLegs` | `api/src/domain/routing.ts` |
| a connection is LEGS, not a trip; the depth ladder and why the mixed tier stops at one stop | `api/src/domain/graphPaths.ts` |
| `empty` is a SUCCESS — why the fetch itself is recorded, and why rendering it as an error destroys the signal | `api/src/endpoints/seatsaeroRoutes.ts`, `docs/SEATS-AERO.md` §12 |
| the JSON-parameter bulk write | `api/src/db/routeGraph.ts` |
| `airportFilter`, the WHERE builder `/api/airports` and `/geo` share, and its bind ordering | `api/src/endpoints/airports.ts` |
| one airport lookup per TABLE rather than per row, and why coordinates ride along with the names | `app/src/hooks/useAirportNames.ts`, `api/src/endpoints/airports.ts` |
| the session key: HKDF over `SESSION_SECRET`, salted with the password, and why both halves are load-bearing | `api/src/middleware/gate.ts` (pinned by `gate.test.ts`) |
| the `HttpOnly; SameSite=Strict` cookie, and why `cors()` names an origin instead of `*` | `api/src/middleware/gate.ts`, `api/src/middleware/security.ts` |
| `scheduled()` running no middleware, and failing closed when `APP_USER_EMAIL` is unset | `api/src/index.ts`, `api/src/alerts/sweep.ts` |
| the sub-hourly CPU limit, the per-tick call cap, and why it is a call cap rather than a route count | `docs/ALERTS.md` §2 |
| the NDJSON reader and its terminal frames | `app/src/api/client.ts` |
| the SPA's only door to the Worker | `app/src/api/index.ts` |
| a JOURNEY is stitched at READ TIME and its total is an addition we did | `app/src/lib/multiLeg.ts` |
| `cash_fees_cents` is NOT always USD — use `money()`, never sum fees across currencies | `app/src/lib/format.ts` |
| preferences: client-only, deliberately not a table and deliberately not the URL | `app/src/lib/preferences.ts` |
| the two named viewport seams, and why they pass `noSsr` | `app/src/hooks/useBreakpoints.ts` |
| `QuotaIndicator` unrendered below `sm`, never `display: none` | `app/src/router.tsx`, at the render site |
| the app bar's three meters, and why D1's two are a separate payload and poll | `app/src/components/QuotaIndicator.tsx`, `app/src/lib/quota.ts` |
| why an absent D1 reading is never a zero, and the third host it needs | `api/src/providers/cloudflareAnalytics.ts`, `api/src/endpoints/d1Usage.ts` |
| the app bar's width is MEASURED, not assumed | `e2e/mobile.spec.ts` |
| card layouts must not drift from the columns they replace; the shared React key | `app/src/pages/routes/findCells.tsx`, `findKey.ts` |
| `showMap` defaults ON while an added option would default off | `app/src/pages/routes/FindsTable.tsx` |
| touch targets bend on `(pointer: coarse)`, not on width | `app/src/theme/build.ts` |
| `accent` as a ground, stated interaction states, `readable()`, and the two deliberate exceptions | `app/src/theme/themes.ts`, `app/src/theme/build.ts` |
| a section nav's links are the page's, and only the frame is shared | `app/src/components/SectionNav.tsx` |
| the two maps' shared basemap, and the one map that uses raster tiles over the network | `app/src/lib/routeMapGeometry.ts` |
| one headless ephemeral browser, the installed Chrome, no persistent context, captured fixtures | `docs/UI-TESTING.md`, `e2e/fixtures.ts` |
| the login dialog shown to a valid-cookie-but-cleared-storage browser — a known bug the harness works around by seeding both halves | `app/src/lib/auth.ts`, `e2e/fixtures.ts` |
