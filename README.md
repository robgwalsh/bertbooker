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
  [`shared/src/data/programs.ts`](shared/src/data/programs.ts),
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

> **There is exactly one data source, and that is a deliberate narrowing.** A
> second one — PointsYeah, a free aggregator — was removed: it was an
> undocumented endpoint reached with browser-shaped headers, and rather than
> guess at whether that was within its terms, it went. Removing it also removed
> the only reason any part of this app ran outside Cloudflare. The cost was two
> programs (`cathay`, `eva`), which nothing reaches now.

## Documentation

- [`docs/SOURCES.md`](docs/SOURCES.md) — what a source is, what may be added, and
  the three ingest rules that keep the database honest
- [`docs/SEATS-AERO.md`](docs/SEATS-AERO.md) — the Partner API integration in
  full: search, enrich, quota, every payload trap
- [`docs/ALERTS.md`](docs/ALERTS.md) — the scheduled sweep: pacing, the budget
  guard, the digest
- [`docs/UI-TESTING.md`](docs/UI-TESTING.md) — driving the SPA headless, with
  nobody at the keyboard
- [`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) — the airline
  scrapers that used to be here, and why they are gone. **Read before proposing
  a source that reads a carrier's own site.**

## Architecture

```
api/ (Hono, Cloudflare)  ──►  D1 (bertbooker_db)
        ▲   │
        │   ├──► seats.aero /partnerapi  (inbound data — the only source)
        │   └──► api.resend.com          (outbound — the alert digest)
        │  GET /api/dashboard · POST …/:id/search (NDJSON) · GET /api/quota
app/ (React + Vite SPA, served by that same worker)

shared/ — imported by api/, by relative path
```

**Everything runs in one place: that Worker.** Two things drive the one source —
pressing Search, and the alerts cron — and both go through the same
`searchRun.ts` and the same `applyTask`, writing the same tables. The app then
*queries the database* they filled.

There used to be a third writer that ran on your own machine, because a second
source could not be trusted to a datacenter IP. Removing that source removed the
runner, the `/api/ingest/*` endpoints, a second shared secret, a second
`.env` file and the npm workspaces that held it all. What is left is three plain
directories under one `package.json`:

- **`shared/`** — the normalized `AvailabilityResult` contract, the source
  registry, the ingest write-pipeline, diff logic, the seats.aero client, program
  seed data. Not a package: `api/` imports it by relative path, and `app/`
  does not import it at all (it hand-mirrors the wire types).
- **`api/`** — the only worker, and it serves the whole app: a Hono API behind a
  shared-password gate (dashboard, saved routes, route search against seats.aero,
  per-row enrichment, alerts), plus the built SPA on every other path, from its
  `[assets]` binding.
- **`app/`** — SPA, three routes: Routes (the dashboard), Library (which is where
  the airports table and map live, as one of its panes) and Alerts (the scheduled
  sweep). Built into `app/dist` and uploaded with the worker above, so the two
  share one origin.

## First-time setup

```sh
git clone https://github.com/robgwalsh/bertbooker.git
cd bertbooker
npm install

npx wrangler login              # needed for D1 and for deploys

# 1. Create the D1 database. Wrangler prints an id — paste it into
#    api/wrangler.toml as `database_id`, REPLACING the one already
#    there (that one is the author's and means nothing on your account).
#    Nothing that touches the database works until you do; wrangler will tell
#    you the database does not exist rather than failing quietly.
npx wrangler d1 create bertbooker_db

# 2. Configure the worker. Every value is documented inline in the template.
#    At minimum you need APP_PASSWORD, SESSION_SECRET and APP_USER_EMAIL, plus
#    SEATS_AERO_API_KEY if you want search to do anything.
cp api/.dev.vars.example api/.dev.vars

#    SESSION_SECRET wants 32 random bytes:
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"

# 3. Apply schema + seed programs to the LOCAL dev database.
npm run db:apply:local
npm run db:seed:local

# 4. Optional: airport reference data (~72k rows) for the Airports tab, the
#    origin/destination autocompletes and the trip list's route maps.
npm run build:airports
npm run db:seed:airports:local
```

`api/.dev.vars` is gitignored and is the **only** environment file — it is the
Worker's, sitting beside the `wrangler.toml` that loads it. There was a second at
the repo root for the local gatherer; both are gone.

If `APP_PASSWORD` or `SESSION_SECRET` is unset, every `/api/*` route answers
**503** with a named reason rather than letting traffic through, and the SPA
renders that as a misconfiguration rather than a password prompt. That is
deliberate: a gate that evaporated when unconfigured would publish the whole app
on one missed setup step.

## Run locally

Two terminals (or your own task runner):

```sh
npm run dev:api        # API worker → http://127.0.0.1:8787
npm run dev:app        # SPA        → http://localhost:5173
```

Open <http://localhost:5173> and sign in with the `APP_PASSWORD` you set.

Note `wrangler dev` does **not** reload `.dev.vars` — edit a value and the old
one keeps working until you restart the API.

There is nothing else to start. Gathering happens inside the Worker, either
because you pressed Search or because the cron fired.

### Local-dev notes

- **Addressing differs per server, and they're opposites.** Wrangler binds IPv4,
  so use `127.0.0.1:8787` (`localhost` can resolve to IPv6 `::1` and hang). Vite
  binds IPv6, so use `localhost:5173` (`127.0.0.1` is refused).
- The local D1 lives under `--persist-to .wrangler-local` at the repo root. Every
  script that touches it — `dev:api` and the `db:*` ones — runs wrangler from the
  root with `--config api/wrangler.toml`; don't change one without the
  others.
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
# 1. Parsers vs. saved fixtures. Offline, hermetic, free.
npm test

# 2. The live payload, captured. THESE SPEND METERED CALLS — read
#    docs/SEATS-AERO.md §11 before either.
npm run probe:seatsaero-search -- --from SFO,OAK --to NRT,HND --days 120
npm run probe:seatsaero-trips  -- --from SFO --to NRT --days 120

# 3. Then press Search in the app, twice. The SECOND run must write zero
#    snapshots — that is write-on-change, and the cheapest end-to-end proof this
#    pipeline has that ids, hashes and coverage claims line up.
```

If `npm test` passes but a live search doesn't, the **service** changed —
re-capture the fixture.

**Never write a parser against a guessed payload.** Probing at both a near and a
far date is also how a source's `horizonDays` gets established. Fixtures are
committed forever, redacted and trimmed — read one before you commit it.

Full guidance is in [`docs/SOURCES.md`](docs/SOURCES.md), and
[`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) §6 is a list of the
probing mistakes this repo has already paid for.

## Test & typecheck

```sh
npm test         # one vitest run over shared/, api/, app/ — offline and hermetic
npm run typecheck
npm run test:ui  # the browser suite, headless — see docs/UI-TESTING.md
```

## Deploy

**One worker serves everything.** The
Hono API answers `/api/*`; every other path is the built SPA, uploaded as the
worker's static assets from `app/dist` (`[assets]` in `api/wrangler.toml`).
That single origin is the reason `app/src/api.ts` can fetch relative `/api/…`
paths deployed exactly as it does in dev, with no base URL and no CORS — and the
reason a hard refresh on `/library` works, via
`not_found_handling = "single-page-application"`.

Deploying gives you a `bertbooker.<your-subdomain>.workers.dev` URL for free.
A custom domain is optional: uncomment the `[[routes]]` block in
`api/wrangler.toml` once the zone is active on your Cloudflare account.
Leaving a route in that names a zone you do not hold **fails the deploy**, which
is why it ships commented out.

Nothing is configured in the repo — set every value on your own account. The
first three are required; the rest match the sections in
`api/.dev.vars.example`.

```sh
cfg="--config api/wrangler.toml"

npx wrangler secret put APP_PASSWORD        $cfg   # required
npx wrangler secret put SESSION_SECRET      $cfg   # required
npx wrangler secret put APP_USER_EMAIL      $cfg   # required — the cron fails closed without it
npx wrangler secret put SEATS_AERO_API_KEY  $cfg   # required to search

npx wrangler secret put RESEND_API_KEY      $cfg   # only for alert emails
npx wrangler secret put ALERT_FROM          $cfg   #   "
npx wrangler secret put APP_URL             $cfg   #   " — base URL for the digest's link

# Apply the schema to the REMOTE database, once:
npm run db:apply:remote
npm run db:seed:remote

npm run deploy    # vite build → wrangler deploy. The build is not optional:
                  # wrangler uploads app/dist as-is, so skipping it ships a
                  # stale bundle without failing.
```

`APP_USER_EMAIL`, `ALERT_FROM` and `APP_URL` are not sensitive — they are set as
secrets only so that no personal value lives in a public repo. If you would
rather keep them in `wrangler.toml` on your own fork, a `[vars]` block works and
secrets override vars of the same name.

If you had `INGEST_TOKEN` set from an earlier version, remove it — nothing reads
it now:

```sh
npx wrangler secret delete INGEST_TOKEN $cfg
```

## Third-party data and services

- **seats.aero** — a paid Partner API, used as documented. Not affiliated with
  this project. See [`docs/SEATS-AERO.md`](docs/SEATS-AERO.md).
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
