# BertBooker

**A self-hosted award-travel availability tracker — a personal seats.aero.**

You save the routes you care about, and BertBooker keeps a database of what award
space actually exists on them: which program, which cabin, how many miles, how
many seats, and — the part most tools leave out — **which of your credit cards
can actually book it**, whether by transferring points or by buying the seat
outright through a travel portal.

It runs entirely on your own Cloudflare account, on the free tier, with your own
API keys. There is no hosted version and nothing phones home.

```
Routes    a dashboard of the routes you track, each with its current finds
Library   a browsable flight database, plus airports and programs reference
Alerts    a scheduled sweep that emails you a digest when something changes
```

### Is this for you?

Probably not, and it is worth being straight about that up front:

- **It is built for one household, not for tenants.** There is one shared
  password and one shared identity — everyone who signs in sees the same tracked
  routes. There are no user accounts, and adding them is not a small change.
- **Its main data source costs money.** seats.aero's Partner API is a paid
  subscription (see below). Without a key the app runs but cannot search.
- **The card list is hardcoded to the author's** — Chase, Capital One, Bilt and
  Citi, deliberately no Amex. Changing that means editing
  [`packages/core/src/data/programs.ts`](packages/core/src/data/programs.ts),
  which is reference data rather than a settings screen.
- **It is a personal project.** It is shared because it may be useful, not
  because it is a product. See [CONTRIBUTING.md](CONTRIBUTING.md).

If you want award search without running anything, use
[seats.aero](https://seats.aero) directly — this app is a client of it.

## What you need

| | |
|---|---|
| **Cloudflare account** | Free tier is enough: Workers, D1 and Cron Triggers all fit inside it. `wrangler` ships as a dev dependency. |
| **seats.aero Partner API key** | **Paid**, and the app's primary source — ~20 programs, a year of dates. See [seats.aero/apidocs](https://seats.aero/apidocs) and [`docs/SEATS-AERO.md`](docs/SEATS-AERO.md). Without it the search endpoint answers 503 rather than an empty result, so a missing key can never be mistaken for "no award space". |
| **Node ≥ 20, npm ≥ 10** | |
| **Resend account** *(optional)* | Only for the alert digest, and only with a domain you have verified for SPF/DKIM. Without it, sweeps still run and still ingest; each digest is just recorded as `skipped`. |
| **Google Chrome** *(optional)* | Only to run the UI suite (`npm run test:ui`), which uses your installed browser rather than a downloaded one. See [`docs/UI-TESTING.md`](docs/UI-TESTING.md). |

> **A note on the second source.** PointsYeah (`runtime: "local"`) is *not* an
> official API — it is an anonymous endpoint observed in the browser, called with
> browser-shaped headers, and it may break without notice. It is the only source
> for two programs (`cathay`, `eva`). Read the disclaimer at the top of
> [`docs/POINTSYEAH.md`](docs/POINTSYEAH.md) before running it; removing it is
> one line if you would rather not.

## Documentation

- [`docs/SOURCES.md`](docs/SOURCES.md) — the source plug-in contract: what a
  source is, where it may run, and how to add one
- [`docs/SEATS-AERO.md`](docs/SEATS-AERO.md) — the Partner API integration in
  full: search, enrich, quota, every payload trap
- [`docs/POINTSYEAH.md`](docs/POINTSYEAH.md) — the local source: its server
  limits, program map, and one gather-time deviation
- [`docs/ALERTS.md`](docs/ALERTS.md) — the scheduled sweep: pacing, the budget
  guard, the digest
- [`docs/UI-TESTING.md`](docs/UI-TESTING.md) — driving the SPA headless, with
  nobody at the keyboard
- [`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) — the airline
  scrapers that used to be here, and why they are gone. **Read before proposing
  a source that reads a carrier's own site.**

## Architecture

```
workers/api (Hono, Cloudflare)  ──►  D1 (bertbooker_db)
        ▲   │
        │   ├──► seats.aero /partnerapi  (inbound data — the only source it calls)
        │   └──► api.resend.com          (outbound — the alert digest)
        │  GET /api/dashboard · POST …/:id/search (NDJSON) · GET /api/quota
web/ (React + Vite SPA, served by that same worker)

packages/local-sources (your machine, residential IP)
        │  POST /api/ingest/*   runs, tasks + offers, logs
        ▼
   the same worker, the same ingest pipeline, the same tables
```

Two things fill one database, and they are told apart by **where they may run**:

- **seats.aero** runs on the Worker (`runtime: "worker"`), because it
  authenticates the key rather than judging the client. Pressing Search, and the
  alerts cron, both drive it.
- **PointsYeah** runs locally (`runtime: "local"`), because its posture from a
  datacenter IP has never been measured. `npm run gather` drives it.

Both go through `applyTask` and write the same tables. The app then *queries the
database* they filled.

- **`packages/core`** — the normalized `AvailabilityResult` contract, the source
  registry and plug-in contract, the ingest write-pipeline, diff logic, the
  seats.aero client, program seed data.
- **`packages/local-sources`** — the runner for sources that must not run on
  Cloudflare. A CLI (`npm run gather`) that plans, executes and POSTs to
  `/api/ingest/*`.
- **`workers/api`** — the only worker, and it serves the whole app: a Hono API
  behind a shared-password gate (dashboard, saved routes, route search against
  seats.aero, per-row enrichment, alerts, ingest, `GET /api/finds`), plus the
  built SPA on every other path, from its `[assets]` binding.
- **`web`** — SPA, three routes: Routes (the dashboard), Library (which is where
  the airports table and map live, as one of its panes) and Alerts (the scheduled
  sweep). Built into `web/dist` and uploaded with the worker above, so the two
  share one origin.

## First-time setup

```sh
git clone https://github.com/robgwalsh/bertbooker.git
cd bertbooker
npm install

npx wrangler login              # needed for D1 and for deploys

# 1. Create the D1 database. Wrangler prints an id — paste it into
#    workers/api/wrangler.toml as `database_id`, REPLACING the one already
#    there (that one is the author's and means nothing on your account).
#    Nothing that touches the database works until you do; wrangler will tell
#    you the database does not exist rather than failing quietly.
npx wrangler d1 create bertbooker_db

# 2. Configure the worker. Every value is documented inline in the template.
#    At minimum you need APP_PASSWORD, SESSION_SECRET and APP_USER_EMAIL, plus
#    SEATS_AERO_API_KEY if you want search to do anything.
cp workers/api/.dev.vars.example workers/api/.dev.vars

#    SESSION_SECRET wants 32 random bytes:
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"

# 3. Optional, and only if you plan to run `npm run gather`:
cp .env.example .env

# 4. Apply schema + seed programs to the LOCAL dev database.
npm run db:apply:local
npm run db:seed:local

# 5. Optional: airport reference data (~72k rows) for the Airports tab, the
#    origin/destination autocompletes and the trip list's route maps.
npm run build:airports
npm run db:seed:airports:local
```

Both `.dev.vars` and `.env` are gitignored. They are **different environments** —
the first is the Worker's, the second is the local gatherer's, and workerd never
reads the latter. They overlap on exactly one key, `INGEST_TOKEN`, because two
processes genuinely need it.

If `APP_PASSWORD` or `SESSION_SECRET` is unset, every `/api/*` route answers
**503** with a named reason rather than letting traffic through, and the SPA
renders that as a misconfiguration rather than a password prompt. That is
deliberate: a gate that evaporated when unconfigured would publish the whole app
on one missed setup step.

## Run locally

Two terminals (or your own task runner):

```sh
npm run dev:api        # API worker → http://127.0.0.1:8787
npm run dev:web        # SPA        → http://localhost:5173
```

Open <http://localhost:5173> and sign in with the `APP_PASSWORD` you set.

Note `wrangler dev` does **not** reload `.dev.vars` — edit a value and the old
one keeps working until you restart the API.

Gathering from a local source is a shell command, not a page:

```sh
npm run gather -- --from SEA --to LAX --days 0-30 --dry   # writes nothing
npm run gather -- --from SEA --to LAX --days 0-30
npm run gather -- --route 1                               # a saved route's window
```

### Local-dev notes

- **Addressing differs per server, and they're opposites.** Wrangler binds IPv4,
  so use `127.0.0.1:8787` (`localhost` can resolve to IPv6 `::1` and hang). Vite
  binds IPv6, so use `localhost:5173` (`127.0.0.1` is refused).
- The local D1 lives under `--persist-to .wrangler-local` at the repo root. Every
  script that touches it — `dev:api` and the `db:*` ones — runs wrangler from the
  root with `--config workers/api/wrangler.toml`; don't change one without the
  others.
- **`INGEST_TOKEN` must be in two files** — `workers/api/.dev.vars` (the Worker's
  copy) and the repo-root `.env` (the gatherer's). Both gitignored. The repo-root
  `.env` is *not* the Worker's environment; workerd never reads it.
- **If the API seems to "hang"** — spinners in the SPA, nothing in the network tab
  or console — the port is wedged, not the code. Ctrl+C doesn't kill
  `wrangler dev` cleanly on Windows: the `workerd` grandchildren survive holding
  :8787, and the next wrangler binds it *alongside* them, so requests are accepted
  and never answered. `npm run dev:api` clears that automatically before starting
  (`predev:api` → `scripts/free-port.mjs`); `npm run dev:api:stop` tears a server
  down by hand.

## Adding or repairing a source

Narrowest scope first — *which* tool fails is the diagnosis.

```sh
# 1. Parsers vs. saved fixtures. Offline, hermetic.
npm test

# 2. The whole source, live, writing nothing. Exercises plan → run → classify →
#    batch; only the three HTTP ingest calls are stubbed.
npm run gather -- --from SEA --to LAX --days 0-30 --sources pointsyeah --dry

# 3. For real, twice. The SECOND run must write zero snapshots — that is
#    write-on-change, and the cheapest end-to-end proof this pipeline has.
npm run gather -- --from SEA --to LAX --days 0-30
```

If `npm test` passes but a live run doesn't, the **service** changed —
re-capture the fixture.

**Never write a parser against a guessed payload.** Probing at both a near and a
far date is also how each source's `horizonDays` gets established. Fixtures are
committed forever, redacted and trimmed — read one before you commit it.

Full guidance is in [`docs/SOURCES.md`](docs/SOURCES.md), and
[`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) §6 is a list of the
probing mistakes this repo has already paid for.

## Test & typecheck

```sh
npm test         # vitest across workspaces — offline and hermetic
npm run typecheck
npm run test:ui  # the browser suite, headless — see docs/UI-TESTING.md
```

## Deploy

**One worker serves everything.** The
Hono API answers `/api/*`; every other path is the built SPA, uploaded as the
worker's static assets from `web/dist` (`[assets]` in `workers/api/wrangler.toml`).
That single origin is the reason `web/src/api.ts` can fetch relative `/api/…`
paths deployed exactly as it does in dev, with no base URL and no CORS — and the
reason a hard refresh on `/library` works, via
`not_found_handling = "single-page-application"`.

Deploying gives you a `bertbooker.<your-subdomain>.workers.dev` URL for free.
A custom domain is optional: uncomment the `[[routes]]` block in
`workers/api/wrangler.toml` once the zone is active on your Cloudflare account.
Leaving a route in that names a zone you do not hold **fails the deploy**, which
is why it ships commented out.

Nothing is configured in the repo — set every value on your own account. The
first three are required; the rest match the sections in
`workers/api/.dev.vars.example`.

```sh
cfg="--config workers/api/wrangler.toml"

npx wrangler secret put APP_PASSWORD        $cfg   # required
npx wrangler secret put SESSION_SECRET      $cfg   # required
npx wrangler secret put APP_USER_EMAIL      $cfg   # required — the cron fails closed without it
npx wrangler secret put SEATS_AERO_API_KEY  $cfg   # required to search

npx wrangler secret put INGEST_TOKEN        $cfg   # only if you run `npm run gather`
npx wrangler secret put RESEND_API_KEY      $cfg   # only for alert emails
npx wrangler secret put ALERT_FROM          $cfg   #   "
npx wrangler secret put APP_URL             $cfg   #   " — base URL for the digest's link

# Apply the schema to the REMOTE database, once:
npm run db:apply:remote
npm run db:seed:remote

npm run deploy    # vite build → wrangler deploy. The build is not optional:
                  # wrangler uploads web/dist as-is, so skipping it ships a
                  # stale bundle without failing.
```

`APP_USER_EMAIL`, `ALERT_FROM` and `APP_URL` are not sensitive — they are set as
secrets only so that no personal value lives in a public repo. If you would
rather keep them in `wrangler.toml` on your own fork, a `[vars]` block works and
secrets override vars of the same name.

**Point `BERTBOOKER_API_URL` at the workers.dev host, not the custom domain.** A
zone with bot protection challenges non-browser traffic before it reaches the
Worker, so ingest POSTs from Node get a 403 challenge page rather than an answer
— after the gathering has already been paid for.

```sh
BERTBOOKER_API_URL=https://bertbooker.<your-subdomain>.workers.dev npm run gather -- --from SEA --to LAX --days 0-30
```

## Third-party data and services

- **seats.aero** — a paid Partner API, used as documented. Not affiliated with
  this project. See [`docs/SEATS-AERO.md`](docs/SEATS-AERO.md).
- **PointsYeah** — **not** an official or documented API, and not affiliated with
  this project. Read the disclaimer at the top of
  [`docs/POINTSYEAH.md`](docs/POINTSYEAH.md) before enabling it.
- **Airport data** — [OurAirports](https://ourairports.com/data/), public domain.
  Regenerate with `npm run build:airports`.
- **Map geometry** — [Natural Earth](https://www.naturalearthdata.com/), public
  domain, via
  [martynafford/natural-earth-geojson](https://github.com/martynafford/natural-earth-geojson).
  Regenerate with `npm run build:world`.
- **Airline and program names** are trademarks of their respective owners, used
  here only to identify the programs a seat can be booked with.

This project does not scrape airline websites, and
[`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) is the record of why
the attempt was abandoned. Read it before proposing a source that reads a
carrier's own site.

## License

[MIT](LICENSE) — © 2026 Rob Walsh.

Provided as-is, with no warranty. You are responsible for your own use of the
third-party services above, including their terms, their rate limits, and any
costs you incur.
