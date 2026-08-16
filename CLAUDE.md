# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

**BertBooker** — a private, self-hosted award-travel availability tracker (a personal
seats.aero) for two users. A dashboard of monitored routes and a browsable flight
database, each result tagged with which of the couple's cards can book it (Chase /
Capital One / Bilt / Citi — **no Amex**).

**Gathering fills one database from two sources, and what separates them is
WHERE each may run.** That is a first-class property of a source
(`runtime: "worker" | "local"`), not a deployment accident. **`docs/SOURCES.md`
is the plug-in contract in full** — the interface, the registry, the runtime
rule, the three ingest rules that keep the database honest, and how to add a
source. Read it before touching anything under `packages/core/src/sources` or
`packages/local-sources`.

- **seats.aero** (`runtime: "worker"`) — pressing Search on a tracked route makes
  the Worker call the **Partner API**, streaming progress back per 90-day chunk.
  Breadth (~20 programs, a year of dates) for a handful of calls.
  **`docs/SEATS-AERO.md` is that integration in full** — the endpoints, the call
  economics, the payload traps, coverage, enrichment, quota. Read it before
  touching `workers/api/src/search.ts`, `src/enrich.ts` or
  `packages/core/src/providers/seatsaero.ts`; none of that detail is repeated
  here.
- **PointsYeah** (`runtime: "local"`) — an aggregator, and the only source this
  app has for `cathay` and `eva`. Run by `npm run gather` on this machine,
  POSTing to `/api/ingest/*`. **`docs/POINTSYEAH.md` is that source in full.**

Both go through the same ingest pipeline (`applyTask`) and write the same tables.
The app then *queries the database* they filled.

**There used to be a third way, and it is gone.** For two weeks this repo drove
airlines' own booking forms in a real off-screen Chrome — Alaska and Delta
shipped, United and Flying Blue were probed and closed. It does not work, and not
for the reason anyone expects: anti-bot was never the wall, **product policy
was**. **`docs/HARVEST-POSTMORTEM.md` is the whole record**, and it is what stops
somebody rediscovering it in a year. Read it before proposing a source that reads
a carrier's own site, and before re-litigating a dropped airline.

There is one more writer, and it finds nothing. **Enrich**
(`workers/api/src/enrich.ts`) buys the itinerary behind a row, on a click. It
claims no coverage and prunes nothing, which is what keeps it out of the sentence
above.

**And one thing does now run on a schedule.** **Alerts**
(`workers/api/src/alerts/`) is a Cron Trigger that re-searches the routes marked
for alerts and emails a digest when something changes. It is the same Search
engine (`searchRun.ts`, two callers and one behaviour) and the same ingest
pipeline — the only new thing is that nobody pressed a button.
**`docs/ALERTS.md` is that process in full**, and §1 of it is the argument
against the four comments in this repo that forbade exactly this. Read it before
touching anything under `workers/api/src/alerts`, `src/email.ts` or the cron in
`wrangler.toml`. Two rules from it that constrain code elsewhere:

- **Unattended work must never fail invisibly.** No email is sent when a sweep
  breaks — only when it finds something — so the Alerts tab and Workers Logs are
  the entire safety net. A sweep that can fail without landing there re-creates
  the exact problem the old "no cron" rule was protecting against.
- **Only `alerts/budget.ts` reads the quota before spending.** The interactive
  paths still spend first and report after; a budget guard anywhere else is the
  deleted one leaking back.

One more consequence constrains almost every change here:

- **The Worker never calls an airline's own site**, and the rule is about who is
  being scored: it may call a service that authenticates the **credential**, and
  may not call one that judges the **client**. Carriers do the latter and refuse
  datacenter IPs — United with an Akamai `428`, Delta with a `444` that survives
  a real browser session replayed verbatim, valid `_abck` and all. (That replay
  was run against Delta only; United is not anti-bot blocked in a browser at all
  — what closes it is a login wall.) If you are adding a `fetch` to an airline in
  `workers/api`, stop.
  It reaches exactly two hosts, and the split is the rule rather than an
  exception list: **inbound data — seats.aero**, allowed because it is a keyed
  vendor API that authenticates the *key*, not the client; **outbound
  notification — Resend**, which is not a data source at all but a delivery
  channel on the same footing. A source that must run somewhere else declares
  `runtime: "local"` and is run by `npm run gather`.

This file is orientation and invariants. The depth lives in `docs/`:
`SOURCES.md` (**the plug-in contract** — what a source is, where it may run, the
ingest rules, adding one; the one place any of that is written down),
`SEATS-AERO.md` (**the whole Partner API integration** — search, enrich, quota,
every payload trap; likewise the one place),
`ALERTS.md` (**the whole scheduled sweep** — the argument for having a cron at
all, the pacing model, the reinstated budget guard, the outbox and the digest;
the one place any of that is written down),
`POINTSYEAH.md` (the local source — its server limits, program map and one
gather-time deviation; the one place any of that is written down),
`UI-TESTING.md` (**how to run and look at the SPA with nobody at the keyboard** —
the headless harness, the session seeding, and the things it must never touch;
the one place any of that is written down),
`HARVEST-POSTMORTEM.md` (**the scrapers that used to be here** — what was tried,
what each probe measured, and why it was abandoned while the source abstraction
was kept).

## Commands

```sh
npm install                 # workspaces: packages/core, packages/local-sources,
                            #             workers/api, web

# Local D1 (--persist-to .wrangler-local, wired into the dev script):
npx wrangler d1 create bertbooker_db   # then paste id into workers/api/wrangler.toml
npm run db:apply:local      # apply migrations/  (schema only)
npm run db:seed:local       # seed/programs.sql (idempotent, re-runnable)

# Run locally (127.0.0.1 for the API, localhost for Vite — see gotchas):
                            # workers/api/.dev.vars (gitignored) needs four lines:
                            #   SEATS_AERO_API_KEY=…   what Search spends
                            #   APP_PASSWORD=…         the shared password; UNSET => every
                            #                          /api/* route answers 503, on purpose
                            #   SESSION_SECRET=…       32 random bytes (base64url) signing the
                            #                          session cookie; UNSET => 503 as well
                            #   INGEST_TOKEN=…         must match the repo-root .env copy, or
                            #                          the gate refuses `npm run gather`
npm run dev:api             # Hono API → 127.0.0.1:8787 (clears a wedged port first)
npm run dev:web             # Vite SPA → localhost:5173 (proxies /api → :8787)
npm run dev:api:stop        # when Ctrl+C left workerd behind — see gotchas

# Gathering from the sources that declare runtime: "local" (today: PointsYeah
# only). Everything else runs on the Worker and is reached by pressing Search.
# The flags and the ladder for adding a source are in docs/SOURCES.md. Do not
# guess a payload.
npm run gather -- --from SEA --to LAX --days 0-30 --dry      # live, writes nothing
npm run gather -- --from SEA --to LAX --days 0-30            # needs dev:api / BERTBOOKER_API_URL

npm run probe:seatsaero-trips -- --from SFO --to NRT --days 120
npm run probe:seatsaero-search -- --from SFO,OAK --to NRT,HND --days 120
                            # BOTH SPEND METERED CALLS — see docs/SEATS-AERO.md
                            # before running either.

# Airport reference data (~72k rows, public-domain OurAirports):
npm run build:airports          # regenerates seed/airports.sql (needs internet)
npm run db:seed:airports:local
npm run build:world             # regenerates web/src/data/worldGeometry.ts, the
                                # basemap the trip list's route maps draw
                                # (needs internet)

npm test                    # vitest across workspaces — offline, no servers, no browser
npm run typecheck           # tsc across workspaces, plus e2e/ (not a workspace)

# Seeing the app. HEADLESS: no window opens, so a run cannot be disturbed by —
# or disturb — whoever is using the machine. Reuses dev:api/dev:web if they are
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
                             # uploads the worker AND web/dist as its assets
```

Single test file / test: `npm -w @bertbooker/core exec vitest run src/providers/pointsyeah.test.ts`
(`-t "<name>"` to filter). Tests live next to sources as `*.test.ts`.

## Layout

Deployed as **one worker** serving both the
API and the SPA at `bertbooker.com` (`www.bertbooker.com` is routed to the same
worker and 308s to the apex, so exactly one origin is ever served). Production is gated by the
shared-password gate (`src/gate.ts`) and nothing else — there is no Cloudflare
Access in front of it, so `APP_USER_EMAIL` is the single shared identity everyone
who knows the password signs in as.

- **`packages/core`** — source-agnostic domain: the normalized
  `AvailabilityResult` contract (`src/types.ts`), the **source plug-in contract
  and registry** (`src/sources/`), the ingest write-pipeline (`src/ingest/`),
  diff (`src/diff.ts`), the shared collapse rule (`src/collapse.ts`), the
  seats.aero and PointsYeah wire handling (`src/providers/`), loyalty-program
  reference data (`src/data/programs.ts`).
- **`packages/local-sources`** (`@bertbooker/local-sources`) — **runs only on your
  machine**, and holds exactly what Cloudflare must not do: the runner for
  sources declaring `runtime: "local"`, plus the `/api/ingest/*` client. A
  workspace so it joins `npm test` and `npm run typecheck`. See
  `docs/SOURCES.md`.
- **`workers/api`** (`@bertbooker/api`) — the only worker. Identity is
  `APP_USER_EMAIL` and it *deliberately ignores*
  `Cf-Access-Authenticated-User-Email` — with no Access in front and no JWT
  verification, that header is a string the client picked. Ingest POSTs present
  `X-Ingest-Token` instead of a password session, and that secret is checked on
  all three of them.
- **`web`** — the SPA, three routes: Routes, Library, Alerts.

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
  across sources at query time by freshest `source_fetched_at`.

### Ingest (`packages/core/src/ingest/apply.ts`)

`applyTask` runs on the Worker, per task, as work completes **during** a run —
gathering can die halfway and the successful tasks should already be durable. It
has **two callers and one behaviour**: `ingest.ts` applies batches POSTed by the
local runner, `search.ts` applies each seats.aero chunk inline. Order is the
safety property: read baseline → write changed snapshots → prune → **record
coverage last**, so a crash under-claims rather than over-claims.

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

### Reading (`workers/api/src/finds.ts`)

Every read of a stored find goes through **one CTE** (`findsCte`), so no two
surfaces can disagree about what a current find is. There used to be two — the
dashboard and a general database browser — and the browser is gone, leaving the
dashboard as the SPA's only reader and `GET /api/finds` as an endpoint with no
client. The CTE is the shape either way: `per_source` (latest per
route/program/cabin/**source**) → `cash_any` (freshest known fare, any source) →
`coverage` (MAX `checked_at`) → `finds` (winner by freshest `source_fetched_at`,
cash price `COALESCE`d forward). A cash fare is an attribute of the itinerary,
not a competing claim about it — hence `cash_any`; without it a find's portal
price would blink in and out as sources take turns being freshest.

**Bookability has two halves, and `bookableWith` is only one.** Transfer partners
say which currencies can *become* the program's miles; a known **cash fare** says
the seat can be *bought* through any card's travel portal regardless.
`bookableCurrencies` (`providers/filter.ts`) is the union, and the SQL mirrors it
(`BOOKABLE_WITH_CLAUSE` with `PORTAL_CURRENCIES` bound as a parameter, plus the
same clause hand-written into the dashboard's join — keep them in step).
Filtering on `bookableWith` alone hides exactly what cash pricing exists to
surface: Alaska is Bilt-only, so a Chase-filtered route showed *nothing* from it
until the fare counted. Delta is the extreme case — SkyMiles takes none of the
couple's currencies, so only a cash fare can ever make a Delta seat reachable.

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
- **`.js` import specifiers resolve to `.ts`**: core uses ESM `./foo.js` imports
  pointing at `foo.ts`. esbuild (wrangler) and Vite (vitest) rewrite the
  extension. Keep the `.js` suffix on relative imports.
- **`@bertbooker/core`'s root export must stay DOM-safe.** `ingest/apply.ts`
  references `D1Database` at module scope, so it is a subpath export
  (`@bertbooker/core/ingest`) and the root exports only the ingest *wire* types.
  Importing the D1 half from the root breaks `@bertbooker/local-sources`'s typecheck.
- **`seed/programs.sql` mirrors `packages/core/src/data/programs.ts`** — keep
  them in sync when adding or editing programs. The seed lives OUTSIDE
  `migrations/` so it stays re-runnable.
- **`seed/airports.sql` is GENERATED — do not hand-edit.** Re-run
  `npm run build:airports`. The `airports` table is standalone reference data
  behind the Airports pane, the origin/destination autocompletes and the map.
- **`web/src/data/worldGeometry.ts` is GENERATED — do not hand-edit.** Re-run
  `npm run build:world`. It is the vector basemap `RouteMap` draws (Natural
  Earth, public domain, simplified to ~54KB) and it is committed so the build
  needs no network. It is *not* interchangeable with the Airports pane's
  Leaflet map: that one is tiles over the network under pan and zoom, this one
  is a fixed inert picture rendered fifteen times per page of the trip list.
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
  the root with `--config workers/api/wrangler.toml`; change one without the
  others and you orphan the database. `workers/api` deliberately has **no `dev`
  script**: a second launch path would duplicate the port and persist path.
- **`migrations_dir` is a property of the `[[d1_databases]]` binding**, not a
  top-level wrangler key.
- **The schema is one applied file, and migrations are one-time and tracked.**
  `migrations/0001_init.sql` is the whole schema. To drop or alter something add
  a new `migrations/000N_*.sql`; never edit an applied one. It was collapsed back
  to a single file at the BertBooker rename, when both databases were recreated
  empty — the eight follow-on migrations that had accumulated are folded into it
  and gone from git. That is a one-off licensed by having no data to preserve,
  not a maintenance habit; the next `000N` is a real migration again.
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
- **Vite proxies exactly one prefix, `/api`, and a second one is a trap.** There
  used to be a `/daemon` proxy to a local process, deliberately NOT named
  `/harvest` — the SPA had a page at that path, and a proxy prefix that shadows a
  client route makes the page unreachable. Both are gone; if you add a proxy,
  check its prefix against `routeTree` in `web/src/router.tsx` first.
- **The password gate fails closed, and that is the point** (`src/gate.ts`). An
  unset `APP_PASSWORD` answers **503 `no_app_password`** on every `/api/*` route
  rather than waving traffic through, which is the opposite of `INGEST_TOKEN`'s
  "unset = no check". The asymmetry is deliberate: a forgotten `INGEST_TOKEN`
  relaxes one check on ingest, whereas a gate that evaporated when unconfigured
  would publish the entire app on one missed `wrangler secret put`. The SPA
  renders that 503 as a named misconfiguration, never as a password prompt.
- **The session key is HKDF over `SESSION_SECRET`, SALTED WITH THE PASSWORD**,
  and both halves of that are load-bearing. The random secret is what stops a
  leaked token being an offline cracking oracle on `APP_PASSWORD` — which is
  exactly what the old scheme was, signing an `<expiry>.<HMAC>` token with the
  password directly over a message an attacker already knows. The password in
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
- **The repo-root `.env` is not the Worker's environment.** It is read by
  `packages/local-sources/src/env.ts` into the *gatherer's* `process.env` and by
  nothing else — workerd never sees it. Putting `APP_PASSWORD` there sets it for
  nobody, and the symptom is a password that is definitely correct being rejected
  as `bad_password`. The Worker's copies are `workers/api/.dev.vars` locally and
  `wrangler secret put` in production; the two files overlap on exactly one key,
  `INGEST_TOKEN`, and that is because both processes genuinely need it.
- **`INGEST_TOKEN` must be in two files** — `workers/api/.dev.vars` and the
  repo-root `.env` — because two processes need it. Both gitignored.
- **`wrangler dev` does not reload `.dev.vars`.** Editing a secret and watching
  the old value still work is not a caching bug in the gate — restart the API.
- **Two things stream NDJSON** — the Worker's search
  (`POST /api/tracked-routes/:id/search`) and its enrich-all
  (`POST /api/tracked-routes/:id/enrich`) — and both hold the same rule: a
  stream ending without a terminal frame is a **failure**, never an empty result.
  Search has **three** terminal frames, not two: `run_done`, `error`, and
  `run_continue`, which means "I stopped inside my subrequest budget, ask again
  from here". `searchRoute` hides that from its consumers by looping, so callers
  still see one continuous stream ending in `run_done` or `error`. `readNdjson` in `web/src/api.ts` is shared; the terminal-frame
  check belongs to each caller. `X-Accel-Buffering: no` is set on every side
  because a buffering proxy defeats the point.
- **The Worker does everything fallible BEFORE opening a stream.** Once the first
  byte is written the response is committed to 200 and the only way left to report
  a problem is an `error` frame. So the route lookup, the missing-key check and
  the chunk plan all run first, as real status codes — a missing
  `SEATS_AERO_API_KEY` is a **503**, never an empty result that would read as "no
  award space".
- **`web/src/api.ts` hand-mirrors the worker's wire types.** Core
  references `D1Database` at module scope and fights a DOM tsconfig, so there is
  no shared import; each mirrored type names its source file. They drift if you
  let them.
- **The shell pads nothing and scrolls nothing; each page owns both.** `Layout`
  (`router.tsx`) is a fixed-height flex column — tab strip, then all the room
  that's left — and the document never scrolls (`html, body, #root` are 100%).
  Pages that are DOCUMENTS wrap themselves in `PagePad` (`ui.tsx`), which
  supplies the old page margin and is their scroll container. The Routes page
  doesn't: it is a workbench, a full-height sidebar beside an editor pane, each
  with its own `overflow` from `md` up and one shared 1px rule between them. The
  panes are told apart by GROUND, not by a gap — the rail is
  `background.chrome`, the editor is `background.default`. That is why
  `STICKY_NAV_TOP` no longer adds `APP_BAR_HEIGHT`: a sticky child is offset
  from its own scroller, which already starts below the bar.
- **The app has TWO named viewport seams and no other media queries**
  (`useIsPhone` = below `sm`, `useIsNarrow` = below `md`, both in `web/src/ui.tsx`).
  Prefer an `sx` breakpoint object; reach for a hook only when the **DOM** has to
  change, which is a smaller set than it looks. It has to change in four places:
  the two finds tables become **cards** below `sm` (a CSS-only `display: block`
  responsive table discards `RoundTripTable`'s `rowSpan={2}`, printing a trip's
  cabin, nights, seats and total twice); Library's `Tabs` flips `orientation`,
  which is a prop; the Routes rail and editor become **one pane at a time** below
  `md`; and `QuotaIndicator` is *unrendered*. Both hooks pass `noSsr` — this is a
  `createRoot` SPA, so the query resolves before first paint instead of flashing
  the desktop layout and correcting.
- **`QuotaIndicator` is UNRENDERED below `sm`, never `display: none`.**
  `QuotaSplash` finds it by `QUOTA_CHIP_ID` and already handles it being absent
  (it skips the flight and fades). A hidden element still resolves by id and
  returns an all-zero rect, so the splash would fly into the top-left corner and
  scale to nothing. There is no third option: hiding it is the broken one.
- **The app bar has no room left, and a test says so.** Tabs plus the right-hand
  controls overrun a 390px bar, and the Toolbar is `overflow: visible` (that is
  what lets the active tab paint over the bar's bottom rule), so they **overlap
  rather than clip**. Scrolling the strip is not available either — an
  `overflow-x: auto` nav clips at its padding box and would eat the
  `marginBottom: -1` that joins the open tab to its page. So the bar is balanced
  by dropping the quota chip, and `e2e/mobile.spec.ts` measures the tab strip
  against `[data-testid="app-bar-controls"]`. **Three is the count**, dev and
  deployed alike; a fourth tab fails that test. It was four until the Harvest tab
  went, and the one that went was the only one that had ever been dev-only.
- **The card layouts must not drift from the columns they replace.** The cell
  bodies that encode decisions — cash quoted beside miles and never ranked
  against it, "never checked" told apart from "checked and empty", a round trip's
  total split by direction — live in `web/src/findCells.tsx` and are rendered by
  both. `web/src/findKey.ts` is the shared React key for the same reason: each
  table now has two call sites, and a key that drifts silently reuses the wrong
  element across the breakpoint. The **Map** is the one column with no card
  equivalent; `showMap` is forced off there, which also drops the
  `/api/airports/lookup` those coordinates exist for.
- **Touch targets bend on `(pointer: coarse)`, not on width** (`COARSE` in
  `buildTheme`). A 390px desktop window is still a mouse and keeps the 30px
  controls the app is drawn at; a phone at that width cannot hit them. Only hit
  areas move — the 13px type ramp is the same on every device. Note `ui:shot`
  makes a plain desktop context, so this is invisible in a screenshot.
- **A theme is a palette, not a stylesheet.** `web/src/themes.ts` is twenty-one
  `ThemeSpec`s — no CSS — and `buildTheme` in `web/src/theme.ts` is the only
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
    bright half is `indicator`, exported as `palette.secondary` — that is what
    every `color="primary"` *text* site was changed to. Collapsing the two is
    what made every filled button look washed out, and
    `themes.contrast.test.ts` now checks `primary` as a ground (`contrastText`
    on it) rather than as a label, which is the assertion that used to force it.
  - **Interaction states are stated, not derived.** `spec.hover`,
    `spec.selected`, `spec.selectedIdle`, `spec.raised`, `spec.inputBg` are
    opaque palette colours, wired into `palette.action` so every MUI list, menu
    and table picks them up. The old build computed them (`alpha(white, 0.035)`,
    `alpha(accent, 0.11)`), and a wash carries no hue — which is exactly why
    nineteen distinct palettes all produced the same slightly-flat grey app.
    `tint(theme, n)` still exists for the map's controls, where there is no
    token for "slightly lighter than whatever this is"; reach for a token first.
  `readable()` nudges a *brand* literal — Bilt's teal, oneworld's gold — only as
  far as it must to be legible, keeping the hue so "the teal one" still means
  Bilt; `buildTheme` runs the same nudge over the ink roles. It fires far less
  than it used to, because the ported palettes are contrast tested at their
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
  `web/src/preferences.ts` keeps one versioned JSON blob under
  `bertbooker.prefs.v1`, read through `useSyncExternalStore` over the same
  listener-set pattern `auth.ts` uses (there is no React context anywhere in
  `web/src`). Not D1, because the password gate means **one shared identity** —
  a stored preference would be one setting for both users, and the first
  disagreement would be a bug with no fix. Not the URL either, which is where
  the Routes page keeps state you would want to *link* (`route`,
  `minNights`/`maxNights`); a preference should appear in no link and survive
  every navigation. `getSnapshot` must keep returning the **cached** object —
  a freshly parsed one per call re-renders forever. `parsePreferences` takes the
  raw string rather than reading storage so it is testable: the web workspace
  runs vitest in Node, with no DOM and no `localStorage`.
- **`FindsTable`'s `showMap` defaults ON while its other options default off.**
  The Map column is a *removal*, so its absent value has to mean "as before",
  while an added column's has to mean "as before" the other way round — the two
  cannot share a default. The caller that made that bite was a general database
  browser, which passed nothing and kept its map; **that pane is gone
  and the Routes page is the only caller left**, so `showRoute` and
  `showProvenance` now have no call site at all. They are kept, not dead weight:
  they name columns the table can genuinely draw and a second multi-route caller
  would need them back. `showMap` is still a prop rather than a preference read
  inside the table, which is the separation that let two callers differ, and
  `RoundTripTable` takes the same prop because the two tables share a column
  order. Hiding it also skips `useAirportNames` — those coordinates feed nothing
  but the maps.
- **There is exactly ONE browser here now, and it is headless and ephemeral.**
  The UI harness (`e2e/`) uses `chromium.launch()` + `newContext()` because
  localhost has no anti-bot and a window that does not exist cannot interrupt
  whoever is using the machine. There used to be a second — headed, parked at
  `--window-position=-32000,-32000`, a **persistent** context at
  `.playwright-profile/` — and every one of those choices was for commercial
  anti-bot, which nothing here fights any more. Do not reintroduce a persistent
  context for the harness: it **locks its directory**, so two runs could not
  overlap. The one rule that carries over is the INSTALLED Chrome
  (`channel: "chrome"`), never a downloaded one, which is why `@playwright/test`
  is installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. A failed launch means
  install Chrome, not `npx playwright install`. See `docs/UI-TESTING.md`.
- **A valid session cookie with no `localStorage` hint still shows the login
  dialog.** `PasswordGate` seeds its `session` state only from
  `bertbooker.auth.expiresAt` (`web/src/auth.ts`), and its one correcting effect
  handles the Worker answering `authenticated: false` — there is no branch for
  `true`. So a cleared-storage-but-kept-cookies browser is asked for a password
  the server has already accepted. It is a known bug rather than a design, which
  is why the UI harness seeds **both** halves into its `storageState`; that
  seeding looks redundant and is not. Don't delete it without fixing the effect.
- **Captured fixtures are committed forever** — the probe and recorder redact
  credential-ish headers and trim long arrays by default. Keep it that way, and
  read a fixture before committing it.
