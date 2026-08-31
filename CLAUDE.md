# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

CRITICAL: Write zero comments unless explaining non-obvious 'why' logic". Use an active voice, no stage performances, and pick the most common word when choosing among alternatives. When changing existing code, NEVER leave comments explaining how it used to be. When writing comments, the audience is someone reading this code in the future for the first time. NEVER document any invariants that you haven't cleared with the user first. Assuming invariants incorrectly poisons future sessions and snowballs.

**What belongs in this file:** what you need *before* you know which file to
open. Once you are in a file, its header comment is the authority and it is kept
fuller than this — `features/search/apply.ts`, `db/finds.ts`, `themes.ts`,
`router.tsx` and their
neighbours all carry their own reasoning at the line it constrains. Don't copy
that reasoning back up here; a second copy is a second thing to drift.

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

npm test                    # ONE vitest run over api/ and app/ (vitest.config.ts)
                            # — offline, no servers, no browser
npm run typecheck           # four tsc projects: api/models/wire, api, app, e2e

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
- **`seed/programs.sql` mirrors `api/src/models/program.ts`** — keep them in
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