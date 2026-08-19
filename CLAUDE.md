# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

**BertBooker** — a private, self-hosted award-travel availability tracker (a personal
seats.aero) for two users. A dashboard of monitored routes and a browsable flight
database, each result tagged with which of the couple's cards can book it (Chase /
Capital One / Bilt / Citi — **no Amex**).

**There is ONE source and ONE place code runs.**

- **seats.aero** — pressing Search on a tracked route makes the Worker call the
  **Partner API**, streaming progress back per 90-day chunk. Breadth (~20
  programs, a year of dates) for a handful of calls.
  **`docs/SEATS-AERO.md` is that integration in full** — the endpoints, the call
  economics, the payload traps, coverage, enrichment, quota. Read it before
  touching `api/src/endpoints/search.ts`, `api/src/search/` or
  `api/src/providers/seatsaero.ts`; none of that detail is repeated here.

Everything reaches the database through one ingest pipeline (`applyTask`) and
writes the same tables. The app then *queries the database* it filled.
**`docs/SOURCES.md` is the source contract in full** — what may be added, the
three ingest rules that keep the database honest, and how to add one. Read it
before touching anything under `api/src/sources` or `api/src/ingest`.

There is one more writer, and it finds nothing. **Enrich**
(`api/src/search/enrich.ts`) buys the itinerary behind a row, on a click. It
claims no coverage and prunes nothing, which is what keeps it out of the sentence
above.

**One thing runs on a schedule.** **Alerts**
(`api/src/alerts/`) is a Cron Trigger that re-searches the routes marked
for alerts and emails a digest when something changes. It is the same Search
engine (`search/run.ts`, two callers and one behaviour) and the same ingest
pipeline, running with nobody pressing a button.
**`docs/ALERTS.md` is that process in full**, including the reasoning for
running unattended work at all. Read it before
touching anything under `api/src/alerts` or the cron in
`wrangler.toml`. Two rules from it that constrain code elsewhere:

- **Unattended work must never fail invisibly.** No email is sent when a sweep
  breaks — only when it finds something — so the Alerts tab and Workers Logs are
  the entire safety net. A sweep that can fail without landing there is
  invisible everywhere.
- **Only `alerts/budget.ts` reads the quota before spending.** The interactive
  paths still spend first and report after; do not add a budget guard anywhere
  else.

One more consequence constrains almost every change here:

- **The Worker never calls an airline's own site**, and the rule is about who is
  being scored: it may call a service that authenticates the **credential**, and
  may not call one that judges the **client**. Carriers do the latter and refuse
  datacenter IPs — United with an Akamai `428`, Delta with a `444` that survives
  a real browser session replayed verbatim, valid `_abck` and all. (That replay
  was run against Delta only; United is not anti-bot blocked in a browser at all
  — what closes it is a login wall.) If you are adding a `fetch` to an airline in
  `api`, stop.
  It reaches exactly two hosts, and the split is the rule rather than an
  exception list: **inbound data — seats.aero**, allowed because it is a keyed
  vendor API that authenticates the *key*, not the client; **outbound
  notification — Resend**, which is not a data source at all but a delivery
  channel on the same footing. A source that fails this test simply does not
  get added — there is no local-execution escape hatch for it.

This file is orientation and invariants. The depth lives in `docs/`:
`SOURCES.md` (**the source contract** — what a source is, what may be added, the
ingest rules, adding one; the one place any of that is written down),
`SEATS-AERO.md` (**the whole Partner API integration** — search, enrich, quota,
every payload trap; likewise the one place),
`ALERTS.md` (**the whole scheduled sweep** — the argument for having a cron at
all, the pacing model, the budget guard, the outbox and the digest;
the one place any of that is written down),
`SEATS-AERO.md` §12 also covers **the route graph** — `GET /partnerapi/routes`,
the per-source cache behind the Tools page's Data coverage tab, and why `200 []` is an
answer rather than a failure,
`UI-TESTING.md` (**how to run and look at the SPA with nobody at the keyboard** —
the headless harness, the session seeding, and the things it must never touch;
the one place any of that is written down),

## Commands

```sh
npm install                 # ONE package.json at the root. No workspaces.

# Local D1 (--persist-to .wrangler-local, wired into the dev script):
npx wrangler d1 create bertbooker_db   # then paste id into api/wrangler.toml
npm run db:apply:local      # apply migrations/  (schema only)
npm run db:seed:local       # seed/programs.sql (idempotent, re-runnable)

# Run locally (127.0.0.1 for the API, localhost for Vite — see gotchas):
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
npm run dev:api:stop        # when Ctrl+C left workerd behind — see gotchas

# There is no gather step. All gathering happens inside the Worker, driven by
# pressing Search or by the cron. The ladder for adding a source is in
# docs/SOURCES.md. Do not guess a payload.

npm run probe:seatsaero-trips -- --from SFO --to NRT --days 120
npm run probe:seatsaero-search -- --from SFO,OAK --to NRT,HND --days 120
                            # BOTH SPEND METERED CALLS — see docs/SEATS-AERO.md
                            # before running either.

# Airport reference data (~72k rows, public-domain OurAirports):
npm run build:airports          # regenerates seed/airports.sql (needs internet)
npm run db:seed:airports:local
npm run build:world             # regenerates app/src/data/worldGeometry.ts, the
                                # basemap the trip list's route maps draw
                                # (needs internet)

npm test                    # ONE vitest run over api/ and app/ (vitest.config.ts)
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
npm run deploy               # ONE artifact: vite build → wrangler deploy, which
                             # uploads the worker AND app/dist as its assets
```

Single test file / test: `npx vitest run api/src/providers/seatsaero.test.ts`
(`-t "<name>"` to filter). Tests live next to sources as `*.test.ts`.

## Layout

Deployed as **one worker** serving both the
API and the SPA at `bertbooker.com` (`www.bertbooker.com` is routed to the same
worker and 308s to the apex, so exactly one origin is ever served). Production is gated by the
shared-password gate (`api/src/middleware/gate.ts`) and nothing else — there is no Cloudflare
Access in front of it, so `APP_USER_EMAIL` is the single shared identity everyone
who knows the password signs in as.

**Three directories, one `package.json`, no workspaces and no path aliases.**
`api/` and `app/` both cross into `shared/` with plain relative specifiers
(`../../shared/src/wire/index.js`), which resolve identically in `tsc`,
wrangler's esbuild, Vite and vitest — which is why no alias is configured
anywhere. Keep the `.js` suffix.

### The wire contract

**`shared/src/wire/` is the one definition of every API request and response**,
read by the Worker that produces it and the SPA that consumes it. **It is also
the whole of `shared/`** — `shared/src/wire/` is the only directory under
`shared/src/`, which is what makes "the SPA imports the wire contract" a fact
about the tree rather than a rule with an exception list.
Three rules keep it working:

- **The SPA imports `shared/`, never `api/`.** There is nothing under `shared/`
  that a browser cannot run, so this needs no list of forbidden modules. The
  import happens in `app/src/api/*`, which re-exports the types so no page or
  component names a path in `shared/`.
- **Every wire declaration is DECLARED in `wire/`, not borrowed from elsewhere.**
  The modules in that directory import only each other, which is what keeps
  the first rule true — nothing in `wire/` reaches into a Worker-only file.
  The declaration lives in `wire/` and the backend module re-exports it (the
  pattern `wire/seatsaero.ts` sets), so `api/` imports its own domain
  vocabulary from `api/src/domain/*`.
- **The Worker is annotated against it** — `const body: T = {…}` on hand-built
  literals, `.all<T>()` on D1 reads. That is what turns the types from
  documentation into a guarantee; without it, drift would only have moved rather
  than stopped. Note the honest limit: **`.all<T>()` is an unchecked assertion**,
  not validation. Nothing compares `T` against the SQL column list, so each row
  type in `wire/rows.ts` names the statement it is asserting about and that
  comment is the only thing keeping the two honest.

`shared/tsconfig.wire.json` enforces the first two. It is the narrowest project
in the repo — no DOM, no `@cloudflare/workers-types` — and it is the only pass
that catches **both** failure modes. `tsc -p app` catches a stray `D1Database`
(loudly, but at the far end of a chain); nothing else catches a wire file
reaching `fetch`/`Response`, because app's lib includes DOM and it would simply
re-drag the 1361-line `providers/seatsaero.ts` into the SPA's bundle. This isn't
theoretical: a single type imported from a Worker-only file is enough to drag
the whole provider along behind it. `shared/tsconfig.json` then checks the same files a second time WITH
DOM and workers-types: that pass proves they compose with the Worker's code, the
narrow one proves they need none of it.

- **`shared/`** — `src/wire/` and nothing else: the request/response contract
  both sides read (above). **Not a package** — no `package.json`, no `exports`
  map, nothing emitted.
- **`api/`** — the only worker, and its `wrangler.toml`. Identity is
  `APP_USER_EMAIL` and it *deliberately ignores*
  `Cf-Access-Authenticated-User-Email` — with no Access in front and no JWT
  verification, that header is a string the client picked. The password
  session is the only credential.
- **`app/`** — the SPA and its `vite.config.ts`, four pages: Routes, Alerts,
  Library, Tools. **Library is reference data and nothing else** — five tabs of
  catalogue (currencies, airline programs, airlines, hotel programs, airports).
  **Tools is the working surface over the seats.aero route graph** — three tabs
  (your tracked routes, data coverage, who flies this pair), and the only page
  besides Routes that can spend a metered call: on Refresh, or on picking a
  program nobody has fetched yet.
  **Both pages' sections are ROUTES, not state** — `/library/airports`,
  `/tools/coverage` — so a section is linkable, survives a reload, and answers
  the back button. `/library` and `/tools` redirect (`replace: true`) to their
  first section, so the bare path is never a blank pane.

### Inside `api/src/`

Grouped by **responsibility class**, which is the split `alerts/` always used
(HTTP surface / impure engine / isolated policy) generalized to the rest.

| | |
| --- | --- |
| `index.ts` | **the composition root, and nothing else.** The middleware chain, the mounts, and the `fetch`/`scheduled` export. If you are adding a handler, it does not go here. |
| `bindings.ts` | `Env` and `Vars`. Every secret is documented on the field, including what its absence does. |
| `middleware/` | the request pipeline: `gate.ts` (password + `/api/auth/*`), `identity.ts`, `security.ts`. |
| `endpoints/` | one `Hono` sub-app per surface, registering **absolute** `/api/...` paths, so every mount in `index.ts` is at `"/"` and the path is greppable from the handler. **Named `endpoints/`, not `routes/`** — "route" already means a tracked route here. |
| `db/` | SQL more than one surface shares: `finds.ts` (the one `findsCte`) and `runs.ts` (the `search_runs`/`search_tasks`/`source_quota` writers). |
| `search/` | the gathering engine — `run.ts` (plan/open/run) and `enrich.ts`. Split from its HTTP shell for the reason in *Ingest* below: two callers, one behaviour. |
| `alerts/` | the scheduled sweep, pure halves included: `sweep.ts`, `budget.ts`, `pace.ts`, `select.ts`, `digest.ts`, `email.ts`. `docs/ALERTS.md`. |
| `domain/` | the source-agnostic model: `types.ts` (`AvailabilityResult`), `diff.ts`, `collapse.ts`, `routing.ts`, and the reference seeds `programs.ts` / `airlines.ts`. |
| `ingest/`, `sources/`, `providers/` | the write pipeline, the source contract and registry, and the seats.aero integration. `docs/SOURCES.md`, `docs/SEATS-AERO.md`. |

**The mount order in `index.ts` is the routing table.** Hono runs matching
handlers in registration order and stops at the first that responds, so
`endpoints/search.ts` and `endpoints/enrich.ts` — which own
`POST /api/tracked-routes/:id/search` and `/enrich` — must stay mounted ahead of
`endpoints/trackedRoutes.ts`, which owns `PATCH`/`DELETE` on
`/api/tracked-routes/:id`. `GET /api/health` and `/api/auth/*` are registered
*before* the gate, which is the only reason login is reachable.

### Inside `app/src/`

Seven directories and three files, and the rule for each is about *who is
allowed to import it*:

| | |
| --- | --- |
| `main.tsx`, `router.tsx`, `index.css` | the entry points. The shell wires pages together and owns nothing else — it takes the Routes page's URL contract from `pages/routes/searchParams.ts` rather than declaring it. |
| `api/` | **the one boundary crossing.** See *The wire contract*. |
| `lib/` | pure logic, no JSX, no React. **`lib/` is where a thing goes when it wants a test**, because `vitest.config.ts` globs `*.test.ts` only — a `*.test.tsx` is not skipped, it is silently never collected, and the run stays green. |
| `hooks/` | shared React hooks — the two named viewport seams, the airport-name lookup, the debounce. |
| `components/` | presentation used by more than one page. |
| `pages/<page>/` | **page-private, co-located with its only consumer.** The finds tables, the itinerary card, the route map and the two stream hooks live under `pages/routes/` because the Routes page is the only thing that reads a stored find. The Airports pane is under `pages/library/airports/` because it is a Library section. `pages/tools/` is the whole Tools page, moved there from `pages/library/seatsaero/` when it stopped being a Library tab. A helper that ends up serving two pages leaves `pages/` for `components/` — `SectionHeader` and `TransferCurrencies` both made that trip. |
| `theme/` | `themes.ts` is the palette catalog, `build.ts` is the only place the app's shape is decided. |
| `data/` | **generated, and path-pinned** — `scripts/build-world-geometry.mjs` writes `app/src/data/worldGeometry.ts` by that exact path. Do not move this directory. |

### Coverage is a stored fact

*"Did anyone actually check (route, date, program), and when?"* must survive from
the gathering process to the querying one, so it is the `search_coverage` table,
upserted by every coverage-claiming task.

- **Only `ok` and `empty` claim coverage** (`COVERAGE_CLAIMING_STATUSES`).
  `failed` / `blocked` / `challenged` / `timeout` / `skipped` claim nothing, so a
  refused task can never delete a real find.
- **`coveredDates` must be read off the payload, never off the plan.** Sites clamp
  windows near today and near their horizon. Over-claiming hard-deletes real
  finds; under-claiming costs a stale row. When unsure, narrow it.
- **Snapshots are per-source**, so a prune is scoped to the source that claimed
  the slice — one source's failure can't destroy another's data. Reads collapse
  across sources at query time by freshest `source_fetched_at`. With one source
  that collapse resolves trivially, and it is kept anyway, because it is what
  makes **retiring** a source a data question with a right answer: delete the
  code and nothing is left with authority to prune what it wrote, so its rows
  read as current forever. `migrations/0002_drop_pointsyeah.sql` is that delete,
  already applied.

### Ingest (`api/src/ingest/apply.ts`)

`applyTask` runs on the Worker, per task, as work completes **during** a run —
gathering can die halfway and the successful tasks should already be durable. It
is reached through `search/run.ts`, which has **two callers and one behaviour**:
the Search endpoint and the alert sweep. Order is the safety property: read
baseline → write changed snapshots → prune → **record coverage last**, so a crash
under-claims rather than over-claims.

- **Write-on-change only:** an `fnv1a` hash per key; identical rows are skipped.
  A re-run with nothing changed upstream writes **zero** rows — the cheapest
  smoke test this pipeline has.
- **The baseline hash is the one STORED on the row, never one recomputed from
  it.** `hashResult` folds `segments` in, and enrichment replaces a summary's
  synthetic segment with real legs — so a recomputed baseline would differ from
  the identical summary arriving next, rewrite the row, and throw the enrichment
  away on every single search, forever. `raw_hash` means "what the source said
  when this row was written", which is the only thing write-on-change is asking.
  Pinned by `applyTask — write-on-change` in `apply.test.ts`; both tests there
  fail if you put `hashResult(previous)` back.
- **`collapseBy`/`collapseBest` is required, not an optimization.** The snapshot
  row is keyed (route, date, program, cabin); two itineraries for one slot would
  collide non-deterministically and the diff would report phantom changes every
  run.
- **Co-terminal answers are real.** A source can return SFO→**HND** itineraries
  for an SFO→NRT search, and the good space is often on the airport nobody asked
  for. `AvailabilityResult` carries optional `origin`/`destination`, and one task
  can touch several route keys (`routesTouched`). The route is therefore part of
  the **collapse key**, the **baseline read** and the
  **coverage claim** — miss any one and you either merge two real finds into one,
  rewrite rows every run, or leave rows prunable-but-never-marked-checked.

### Reading (`api/src/db/finds.ts`)

Every read of a stored find goes through **one CTE** (`findsCte`), so no two
surfaces can disagree about what a current find is. **The dashboard is the
only reader**, which is the arrangement that keeps it exercised: a change
to this CTE is exercised by the surface that matters. The CTE has one shape: `per_source` (latest per
route/program/cabin/**source**) → `cash_any` (freshest known fare, any source) →
`coverage` (MAX `checked_at`) → `finds` (winner by freshest `source_fetched_at`,
cash price `COALESCE`d forward). A cash fare is an attribute of the itinerary,
not a competing claim about it — hence `cash_any`; without it a find's portal
price would blink in and out as sources take turns being freshest.

**Bookability has two halves, and `bookableWith` is only one.** Transfer partners
say which currencies can *become* the program's miles; a known **cash fare** says
the seat can be *bought* through any card's travel portal regardless.
`bookableCurrencies` (`providers/filter.ts`) is the union, and the SQL mirrors it
in `ROUTE_FINDS_MATCH`'s currency clause — **keep the two in step.**
Nothing calls `bookableCurrencies` at runtime — every filtering caller is on
the read side and speaks SQL — so it is kept as the testable statement of
the rule, which is why `filter.test.ts` pins it.
Filtering on `bookableWith` alone hides exactly what cash pricing exists to
surface: Alaska is Bilt-only, so a Chase-filtered route would show nothing
from it without the fare counting. Delta is the extreme case — SkyMiles
takes none of the couple's currencies, so only a cash fare can ever make a
Delta seat reachable.

## Non-obvious gotchas

- **A sub-hourly cron gets 30 SECONDS of CPU; an hourly one gets 15 minutes.**
  That platform limit is why `crons = ["*/15 * * * *"]` sweeps exactly one route
  per tick and resumes wide ones through the existing `run_continue` mechanism.
  Waiting on seats.aero is I/O and free; parsing a 500-row page of trips is the
  CPU that would blow it. Subrequests are *not* the constraint (10,000 per
  invocation, though D1 calls do count). Raising the tick's workload without
  raising the cron interval is how you get silent CPU-limit kills.
- **`scheduled()` runs NO middleware** — not `cors`, `csrf`, `gate`, `identity`,
  or `applySecurityHeaders`. Identity is `env.APP_USER_EMAIL` read directly, and
  `runAlertTick` fails closed when it is unset, because `search_runs.user_email`
  is NOT NULL. It is `await`ed rather than `ctx.waitUntil`'d: an async
  `scheduled` handler's promise is already awaited, and awaiting is what makes a
  throw show up as a *failed invocation* in Workers Logs — which matters more
  here than anywhere, because no email reports it.
- **`SearchKind` vs `ProgramKind`** (`types.ts`): a *search* is `flight | hotel`;
  a *program* is `airline | hotel`. Different types — don't conflate.
- **`.js` import specifiers resolve to `.ts`**: `shared/` and `api/` use ESM
  `./foo.js` imports pointing at `foo.ts`, and both `api/` and `app/` reach
  `shared/` the same way (`../../shared/src/wire/index.js`). esbuild (wrangler)
  and Vite (vitest) rewrite the extension. Keep the `.js` suffix on relative
  imports.
- **There is no barrel in `api/src/`, and that is deliberate.** A barrel that
  re-exports the whole domain hides which subsystem an imported symbol comes
  from. Imports name the owning module
  (`../providers/seatsaero.js`, `../domain/routing.js`). Don't reintroduce one.
- **`api/src/index.ts` imports `./sources/index.js` for its SIDE EFFECT**, and
  that line is the whole of a real check. `sources/index.ts` calls
  `registerSource(seatsAeroSource)` at module scope, which validates every
  program the source declares against `PROGRAM_SEEDS`;
  `availability_snapshots.program` is a foreign key, so without it a typo
  surfaces as a write failing mid-search instead of as a worker that won't boot.
  Nothing imports a *symbol* from `sources/`, so it looks removable. It is not.
- **`seed/programs.sql` mirrors `api/src/domain/programs.ts`** — keep
  them in sync when adding or editing programs. The seed lives OUTSIDE
  `migrations/` so it stays re-runnable.
- **`seed/airports.sql` is GENERATED — do not hand-edit.** Re-run
  `npm run build:airports`. The `airports` table is standalone reference data
  behind the Airports pane, the origin/destination autocompletes and the map.
- **`app/src/data/worldGeometry.ts` is GENERATED — do not hand-edit.** Re-run
  `npm run build:world`. It is the vector basemap (Natural Earth, public domain,
  simplified to ~54KB), committed so the build needs no network, and it now
  feeds **two** maps through two different functions in
  `lib/routeMapGeometry.ts`: `basemapPaths()` projects and culls it into the SVG
  the trip list's `RouteMap` draws fifteen times a page, and `basemapRings()`
  hands it to Leaflet unprojected for the Tools page's route graph. Both
  paint it in the same green-over-blue literals, exported from that same module
  so the two cannot drift.
  The one map it does *not* feed is the **Airports pane's**, which is raster
  tiles over the network — the reason `*.basemaps.cartocdn.com` is in the CSP,
  and the reason that map alone cares about the theme's light/dark polarity.
- **The trip list's route maps get their coordinates from
  `/api/airports/lookup`**, which is why that endpoint returns lat/lon beside
  the names. One lookup per *table*, keyed on the visible page's codes — a
  `useAirportNames` call per row would be one request per find.
- **`/api/airports` and `/api/airports/geo` share one WHERE builder**
  (`airportFilter`) — that's what guarantees table and map show the same set once
  the user searches. It owns the "no query and no filters → scheduled large
  airports" default, which the geo route opts out of (`defaultToMajors: false`),
  and it pushes WHERE binds first, so callers append ORDER BY/LIMIT binds after.
- **`findsCte`'s scope binds are consumed TWICE** (inner grouping and outer
  filter). Get the order wrong and the query silently filters on wrong values.
- **The local D1 lives under `--persist-to .wrangler-local`** (repo root). Every
  script that touches it — `dev:api` and all the `db:*` ones — runs wrangler from
  the root with `--config api/wrangler.toml`; change one without the
  others and you orphan the database. There is only one launch path, and that is
  the point: with a single root `package.json` there is nowhere else to put a
  second one that would duplicate the port and the persist path.
- **`migrations_dir` is a property of the `[[d1_databases]]` binding**, not a
  top-level wrangler key.
- **Migrations are one-time and tracked; never edit an applied one.**
  `migrations/0001_init.sql` is the base schema and `0002_drop_pointsyeah.sql` is
  the first real delta on top of it.
  **0001 is the record of what was APPLIED, not a description of the live
  schema**: it still creates `search_logs` and `search_tasks.artifact_path`,
  which 0002 drops. Both are annotated `DROPPED BY 0002` in place — annotate,
  don't delete, or a fresh database and a migrated one stop agreeing.
  `0003_seatsaero_routes.sql` is the route-graph cache — purely additive, and
  the next number is 0004.
- **`empty` is a SUCCESS, and the route-graph tables exist to say so.**
  seats.aero answers `200 []` for a source name it does not recognise, so
  "no rows for X" is ambiguous between *never asked* and *that name is wrong*
  unless the fetch itself is recorded. `seatsaero_route_fetches` is that record;
  rendering `empty` as an error destroys the one signal the pane is for.
  `docs/SEATS-AERO.md` §12.
- **`POST /api/seatsaero/sources/:source/fetch` is METERED**, and it is the only
  path under `/api/seatsaero/*` that is. It is listed in `METERED_PATTERNS`
  (`e2e/fixtures.ts`) beside search and enrich — a UI test that reaches it fails
  rather than quietly spending a call. **Two things reach it**: the Refresh
  button, and *picking a program nobody has fetched yet*. That second one is why
  no spec in `e2e/tools.spec.ts` may touch the source dropdown's options,
  and why the auto-fetch fires on an explicit selection and never on mount —
  `/tools/coverage` has to stay free to open, because the harness visits it
  every run.
  `docs/SEATS-AERO.md` §12 has the other two guards.
- **D1 allows 100 bound parameters per query, not SQLite's 999**, and 1,000
  queries per Worker invocation with batch statements counting. That is why the
  route-graph writer binds a 500-row chunk as ONE JSON parameter and expands it
  with `json_each` (`api/src/db/routeGraph.ts`) instead of a multi-row `VALUES`,
  which would fit twelve rows and need ~700 statements for one program.
- **Retiring a source is a migration, not just a deletion.** Prunes are scoped
  per source, so deleting a source's code leaves nothing with the authority to
  clean up its rows and they read as current forever. `migrations/0002_drop_pointsyeah.sql`
  is that cleanup, already applied.
- **Local dev addressing on Windows differs per server.** Wrangler binds IPv4, so
  use `127.0.0.1:8787` (`localhost` → IPv6 `::1` hangs). Vite binds IPv6, so use
  `localhost:5173` (`127.0.0.1` is refused). Opposite, and both right.
- **"The API hangs" is always a wedged port, never the code.** Ctrl+C doesn't kill
  `wrangler dev` cleanly on Windows — `workerd` grandchildren survive holding
  :8787, and Windows lets the *next* wrangler bind it too. Connections split
  between a live worker and a dead one: the socket accepts, nothing answers, and
  the SPA shows pending spinners with **nothing in the network tab or console**.
  Killing `workerd` alone doesn't help — the orphaned wrangler parent respawns
  it. `scripts/free-port.mjs` kills the whole tree (matched by repo path, so
  other projects are untouched) and runs as `predev:api`; `npm run dev:api:stop`
  tears one down by hand.
- **Vite proxies exactly one prefix, `/api`, and a second one is a trap.** A
  proxy prefix that shadows a client route makes that page unreachable. If you
  add a proxy, check its prefix against `routeTree` in `app/src/router.tsx`
  first.
- **`identity` refuses everything when `APP_USER_EMAIL` is unset**, and the
  symptom is every page rendering its shell over a wall of `401 unauthenticated`
  — not a password prompt, because the gate already passed. It is required in
  `api/.dev.vars` for local dev, not just in production.
- **The session key is HKDF over `SESSION_SECRET`, SALTED WITH THE PASSWORD**,
  and both halves of that are load-bearing. The random secret is what stops a
  leaked token being an offline cracking oracle on `APP_PASSWORD` — signing a
  token with the password directly, over a message an attacker already knows,
  would be exactly that oracle. The password in
  the salt is what keeps rotating `APP_PASSWORD` a revocation: it changes the
  key, so every live session dies. Dropping either one still signs and verifies
  perfectly, which is why `gate.test.ts` pins both.
- **The session is an `HttpOnly; SameSite=Strict` cookie**, so no script on the
  page can read it and no other site can make the browser send it. That is why
  `cors()` names an origin instead of `*` (a wildcard cannot carry credentials
  and browsers reject the pair) and why `csrf()` sits in front of the gate. It
  works in dev only because Vite proxies `/api` to :8787 — the browser sees one
  origin, so the cookie is same-site there exactly as in production.
- **`gate` runs before `identity`, and `/api/auth/*` and `/api/health` escape it
  by being registered first.** Hono runs matching handlers in registration
  order and stops at the first that responds; move the `app.route("/", authRoutes)`
  line below `app.use("/api/*", gate)` and login becomes unreachable — you
  would need the password to ask for the password.
- **`api/.dev.vars` is the only environment file**, and it sits beside the
  `wrangler.toml` that loads it. Putting `APP_PASSWORD` anywhere else sets it
  for nobody — workerd only reads this file — and a definitely-correct
  password gets rejected as `bad_password`. Production's copies are
  `wrangler secret put`.
- **`wrangler dev` does not reload `.dev.vars`.** Editing a secret and watching
  the old value still work is not a caching bug in the gate — restart the API.
- **Two things stream NDJSON** — the Worker's search
  (`POST /api/tracked-routes/:id/search`) and its enrich-all
  (`POST /api/tracked-routes/:id/enrich`) — and both hold the same rule: a
  stream ending without a terminal frame is a **failure**, never an empty result.
  Search has **three** terminal frames, not two: `run_done`, `error`, and
  `run_continue`, which means "I stopped inside my subrequest budget, ask again
  from here". `searchRoute` hides that from its consumers by looping, so callers
  still see one continuous stream ending in `run_done` or `error`. `readNdjson` in `app/src/api/client.ts` is shared; the terminal-frame
  check belongs to each caller. `X-Accel-Buffering: no` is set on every side
  because a buffering proxy defeats the point.
- **The Worker does everything fallible BEFORE opening a stream.** Once the first
  byte is written the response is committed to 200 and the only way left to report
  a problem is an `error` frame. So the route lookup, the missing-key check and
  the chunk plan all run first, as real status codes — a missing
  `SEATS_AERO_API_KEY` is a **503**, never an empty result that would read as "no
  award space".
- **`app/src/api/index.ts` is the SPA's only door to the Worker** — every other
  file imports from `./api` and knows nothing about the boundary. It assembles
  the `api` object from the modules beside it and re-exports the wire types
  from `shared/src/wire/`; see *The wire contract* for what enforces that.
- **The shell pads nothing and scrolls nothing; each page owns both.** `Layout`
  (`router.tsx`) is a fixed-height flex column — tab strip, then all the room
  that's left — and the document never scrolls (`html, body, #root` are 100%).
  Pages that are DOCUMENTS wrap themselves in `PagePad` (`components/PagePad.tsx`), which
  supplies the page margin and is their scroll container. The Routes page
  doesn't: it is a workbench, a full-height sidebar beside an editor pane, each
  with its own `overflow` from `md` up and one shared 1px rule between them. The
  panes are told apart by GROUND, not by a gap — the rail is
  `background.chrome`, the editor is `background.default`. That is why
  `STICKY_NAV_TOP` does not add `APP_BAR_HEIGHT`: a sticky child is offset
  from its own scroller, which already starts below the bar.
- **The app has TWO named viewport seams and no other media queries**
  (`useIsPhone` = below `sm`, `useIsNarrow` = below `md`, both in `app/src/hooks/useBreakpoints.ts`).
  Prefer an `sx` breakpoint object; reach for a hook only when the **DOM** has to
  change, which is a smaller set than it looks. It has to change in three places:
  the two finds tables become **cards** below `sm` (a CSS-only `display: block`
  responsive table discards `RoundTripTable`'s `rowSpan={2}`, printing a trip's
  cabin, nights, seats and total twice); the Routes rail and editor become **one
  pane at a time** below `md`; and `QuotaIndicator` is *unrendered*. It used to
  be four: Library's `Tabs` flipped `orientation`, which is a prop and not a
  style. `SectionNav` replaced that `Tabs` with plain flex, so the column/strip
  swap is `flexDirection: { xs: "row", md: "column" }` and the hook went away —
  which is the direction this list should always move. Both hooks pass `noSsr` — this is a
  `createRoot` SPA, so the query resolves before first paint instead of flashing
  the desktop layout and correcting.
- **`QuotaIndicator` is UNRENDERED below `sm`, never `display: none`.**
  `QuotaSplash` finds it by `QUOTA_CHIP_ID` and already handles it being absent
  (it skips the flight and fades). A hidden element still resolves by id and
  returns an all-zero rect, so the splash would fly into the top-left corner and
  scale to nothing. There is no third option: hiding it is the broken one.
- **The app bar's width is MEASURED, not assumed.** When the tabs and the
  right-hand controls stop fitting a 390px bar they **overlap rather than clip** —
  the Toolbar is `overflow: visible`, which is what lets the active tab paint over
  the bar's bottom rule. That bug shipped once, so `e2e/mobile.spec.ts` measures
  the tab strip against `[data-testid="app-bar-controls"]`.
  This bullet used to read "three is the count; a fourth tab fails that test".
  **It was a guess and it was wrong** — Tools went in fourth and the measurement
  at 390px is 214px of tabs against 69px of controls, leaving **105px of slack**.
  Ask the test, not this file. Two levers are already spent or foreclosed
  though, so the slack is all there is: the quota chip is dropped below `sm`
  (that was the fix last time), and scrolling the strip is not available — an
  `overflow-x: auto` nav clips at its padding box and would eat the
  `marginBottom: -1` that joins the open tab to its page. A short label is the
  cheapest thing left, which is why "Tools" is the shortest on the bar.
- **A section nav's links are the page's, and only the frame is shared.**
  `components/SectionNav.tsx` is the Library's and Tools' left nav: a `<nav>` of
  TanStack `<Link>`s, styled as descendants (`"& a"`, `'& a[data-status="active"]'`).
  It looks like it should own the links and take a `to`, and it must not — MUI's
  `styled(Link)` erases the router generics so `params` widens to `AnyRouter`,
  and a `to` that is a union of both parents resolves TanStack's params to
  `never`. Either way `params={{ tab }}` stops being checked. A literal `to` at
  each call site is the only shape that stays type-safe.
- **The card layouts must not drift from the columns they replace.** The cell
  bodies that encode decisions — cash quoted beside miles and never ranked
  against it, a round trip's total split by direction — live in
  `app/src/pages/routes/findCells.tsx` and are rendered by both.
  `app/src/pages/routes/findKey.ts` is the shared React key for the same reason: each
  table has two call sites, and a key that drifts silently reuses the wrong
  element across the breakpoint. The **Map** is the one column with no card
  equivalent; `showMap` is forced off there, which also drops the
  `/api/airports/lookup` those coordinates exist for.
- **Touch targets bend on `(pointer: coarse)`, not on width** (`COARSE` in
  `buildTheme`). A 390px desktop window is still a mouse and keeps the 30px
  controls the app is drawn at; a phone at that width cannot hit them. Only hit
  areas move — the 13px type ramp is the same on every device. Note `ui:shot`
  makes a plain desktop context, so this is invisible in a screenshot.
- **A theme is a palette, not a stylesheet.** `app/src/theme/themes.ts` is twenty-one
  `ThemeSpec`s — no CSS — and `buildTheme` in `app/src/theme/build.ts` is the only
  place the app's *shape* is decided (square corners, solid rules, 13px density,
  a chrome colour distinct from the page). Adding a theme is adding a spec and
  nothing else; no theme can restyle a component.
- **The palettes are PORTED from BertBrowser** (a separate, private project of
  the author's) — `BertBrowser.Core/Theming/ThemeCatalog.cs`, token for token,
  resolved through its one level of inheritance. That source is not public, so a
  contributor cannot re-sync; treat the specs here as the record. Re-sync from
  there if you have it rather than eyeballing a new
  colour; each `ThemeSpec` field's doc comment names the token it came from.
  Two consequences that are easy to undo by accident:
  - **`accent` is a GROUND, not ink.** It is dark enough to carry `onAccent`
    (VS Code's `#0E639C`, not its `#3794FF`), so `palette.primary` is the fill
    a contained button gets and `contrastText` is what survives on it. The
    bright half is `indicator`, exported as `palette.secondary` — every
    `color="primary"` *text* site should use that, not `primary`, or the
    button reads as washed out.
    `themes.contrast.test.ts` checks `primary` as a ground (`contrastText`
    on it) rather than as a label.
  - **Interaction states are stated, not derived.** `spec.hover`,
    `spec.selected`, `spec.selectedIdle`, `spec.raised`, `spec.inputBg` are
    opaque palette colours, wired into `palette.action` so every MUI list, menu
    and table picks them up. A computed wash (`alpha(white, 0.035)`,
    `alpha(accent, 0.11)`) carries no hue, which is why these are stated
    tokens rather than derived from the accent colour.
    `tint(theme, n)` still exists for the map's controls, where there is no
    token for "slightly lighter than whatever this is"; reach for a token first.
  `readable()` nudges a *brand* literal — Bilt's teal, oneworld's gold — only as
  far as it must to be legible, keeping the hue so "the teal one" still means
  Bilt; `buildTheme` runs the same nudge over the ink roles. It fires rarely,
  because the ported palettes are already contrast tested at their
  source. `themes.contrast.test.ts` asserts on the BUILT theme — the catalog is
  allowed to fail it, the painted app is not. Leaflet and the trip list's
  `RouteMap` are the two deliberate exceptions: Leaflet gets a hand-written
  `GlobalStyles` restatement plus a light/dark tile URL because raster tiles
  can't be recoloured, and `RouteMap`'s cartography stays literal because the
  palette has no "ocean".
- **A strong selection fill is wrong for this app's lists.** `spec.selected` is
  meant for rows of plain text; every list here carries colour in its rows —
  cabin chips, airline marks, a green find count — and a saturated ground erases
  all of it. Lists use `spec.selectedIdle` plus a 3px `spec.indicator` bar, which
  is also how the file browser draws its own tree. `selected`/`onSelected` are
  spent on `::selection` and the picker's swatches.
- **User preferences are client-only, and deliberately not a table.**
  `app/src/lib/preferences.ts` keeps one versioned JSON blob under
  `bertbooker.prefs.v1`, read through `useSyncExternalStore` over the same
  listener-set pattern `auth.ts` uses (there is no React context anywhere in
  `app/src`). Not D1, because the password gate means **one shared identity** —
  a stored preference would be one setting for both users, and the first
  disagreement would be a bug with no fix. Not the URL either, which is where
  the Routes page keeps state you would want to *link* (`route`,
  `minNights`/`maxNights`); a preference should appear in no link and survive
  every navigation. `defaultAirport` is the one preference whose valid values
  are a SHAPE rather than a boolean or a closed set — three letters or `""` —
  so `parsePreferences` checks it with `isAirportCode` and `""` is honoured as a
  deliberate choice rather than falling back. `getSnapshot` must keep returning the **cached** object —
  a freshly parsed one per call re-renders forever. `parsePreferences` takes the
  raw string rather than reading storage so it is testable: **the whole vitest
  run is Node**, with no DOM and no `localStorage` (`vitest.config.ts` is one
  flat project over `shared/`, `api/` and `app/`).
- **`FindsTable`'s `showMap` defaults ON while an added option would default
  off.** The Map column is a *removal*, so its absent value has to mean "as
  before", while an added column's has to mean "as before" the other way round —
  the two cannot share a default. That asymmetry is the rule to keep when adding
  the next option. The Routes page is the only caller.
  `showMap` is a prop rather than a preference read inside the table, so two
  callers can differ, and `RoundTripTable` takes the same prop because the
  two tables share a column order. Hiding it also skips `useAirportNames` —
  those coordinates feed nothing but the maps.
- **There is exactly ONE browser here, and it is headless and ephemeral.**
  The UI harness (`e2e/`) uses `chromium.launch()` + `newContext()` because
  localhost has no anti-bot and a window that does not exist cannot interrupt
  whoever is using the machine. Do not introduce a persistent
  context for the harness: it **locks its directory**, so two runs cannot
  overlap. Use the INSTALLED Chrome
  (`channel: "chrome"`), never a downloaded one — which is why `@playwright/test`
  is installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. A failed launch means
  install Chrome, not `npx playwright install`. See `docs/UI-TESTING.md`.
- **A valid session cookie with no `localStorage` hint still shows the login
  dialog.** `PasswordGate` seeds its `session` state only from
  `bertbooker.auth.expiresAt` (`app/src/lib/auth.ts`), and its one correcting effect
  handles the Worker answering `authenticated: false` — there is no branch for
  `true`. So a cleared-storage-but-kept-cookies browser is asked for a password
  the server has already accepted. It is a known bug rather than a design, which
  is why the UI harness seeds **both** halves into its `storageState`; that
  seeding looks redundant and is not. Don't delete it without fixing the effect.
- **Captured fixtures are committed forever** — the probe and recorder redact
  credential-ish headers and trim long arrays by default. Keep it that way, and
  read a fixture before committing it.
