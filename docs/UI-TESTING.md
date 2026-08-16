# UI testing

Driving the SPA in a real browser with nobody at the keyboard: `e2e/`,
`playwright.config.ts`, and the two root scripts that run them.

This exists because **nothing in `npm test` has ever rendered a component.** The
web workspace runs vitest in a Node environment with no DOM (`web/vite.config.ts`
has no `test` key at all), so its tests are pure functions — `parsePreferences`,
`roundtrip`, the theme contrast maths. That is the right shape for those tests
and it leaves a hole exactly where the app is: a thrown React error, a page that
renders to a blank pane, a panel quietly showing its error state, a palette that
paints text on its own background. All of them are invisible until somebody opens
a browser.

Two things live here, and they answer different questions:

- **The suite** (`e2e/*.spec.ts`, `npm run test:ui`) — *does it still work?*
- **The driver** (`e2e/shot.ts`, `npm run ui:shot`) — *what does it look like
  right now?* Ad-hoc, no assertions, writes a PNG.

---

## 1. It must be impossible to disturb

This is the requirement, not a side effect. The machine's owner is usually
working in other applications while a run happens.

1. **Headless Chrome has no window.** No OS focus, no compositor surface, no
   taskbar entry. Clicks, Alt-Tabs and window drags cannot reach it, and it
   cannot steal keyboard focus.
2. **Screenshots come from the renderer over CDP, not from the screen.** Whatever
   is on top of the desktop never lands in an image.
3. **`reuseExistingServer`.** A dev pair that is already up is attached to and
   left alone — not restarted, and *not killed on the way out*. Measured: a run
   that starts the API itself tears that one down and leaves an
   already-running Vite untouched.
4. **`workers: 1`.** Both servers and the local D1 (`--persist-to
   .wrangler-local`) are one shared instance; parallel workers would interleave
   against one sqlite file.
5. **External hosts are stubbed**, so a slow tile server cannot flake a run.
6. **`page.bringToFront()` is banned.** It raises a window. Nothing under `e2e/`
   may call it.

The one flag that breaks all of this is `--show` on the driver, which runs
headed. It is there because a human sometimes wants to watch. **An agent must
never pass it**, and the script prints a warning when it is used.

Same rule for `playwright test --headed`, `--ui`, `--debug`, and
`playwright show-trace`: all four open a window. The HTML reporter is configured
`open: "never"` for exactly this reason — its default pops a browser at whoever
is at the keyboard the moment a test fails. Read a report deliberately, with
`npm run test:ui:report`.

## 2. Headless and ephemeral, and it must stay both

This repo used to hold a second Playwright browser, and it was the opposite of
this one on every axis: **headed** (parked off-screen at
`--window-position=-32000,-32000`) and a **persistent** context rooted at
`.playwright-profile/`, because commercial anti-bot is tuned to catch headless
Chrome and a warm profile is what kept an airline answering.

That browser and the scrapers it drove are gone (`docs/HARVEST-POSTMORTEM.md`),
and none of its choices was ever right here:

- There is no anti-bot on the Vite dev server. Headless is simply better, because
  a window that does not exist cannot be interrupted.
- **A persistent context locks its directory**, so two runs could not overlap,
  for no gain — there is no reputation to accumulate against localhost.

So the harness uses `chromium.launch()` + `newContext()`, never
`launchPersistentContext`. If you are reintroducing browser automation for
anything other than the local SPA, do not point it at this harness.

One thing that carries over: **the installed Chrome, never a downloaded one.**
`channel: "chrome"` resolves the real browser, and `@playwright/test` is installed
with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so its postinstall does not fetch ~1GB
of bundled Chromium and Firefox and WebKit that nothing here would use. If a
launch ever fails, the fix is **install Chrome** — *not* `npx playwright install`,
which downloads precisely the browser this config declines to use.

## 3. The two servers

`playwright.config.ts` declares both as `webServer` entries running the **same
root scripts a human runs** — `npm run dev:api` and `npm run dev:app`. Never an
inlined `wrangler dev`: `api` deliberately has no `dev` script because a
second launch path would duplicate the port and the persist path, and that would
be the second path.

`reuseExistingServer: true` unconditionally (there is no CI here). When Playwright
*does* start the API, `predev:api` → `scripts/free-port.mjs` clears a wedged 8787
first — and because that only runs when the port was not answering, it can never
take down a healthy server somebody is using.

Addressing is asymmetric and both halves are right: the API probe is
`http://127.0.0.1:8787/api/health` because wrangler binds IPv4, while `baseURL`
is `http://localhost:5173` because Vite binds IPv6. See CLAUDE.md's gotchas.

**A run that hangs waiting for a server is a wedged port, never the config.** A
dead `workerd` holding :8787 accepts the socket and never answers, so the probe
times out rather than failing fast. `npm run dev:api:stop`, then run again.

## 4. Auth, and the one genuinely surprising thing here

The app is behind a shared-password gate, so `e2e/global-setup.ts` logs in once
and leaves a `storageState` at `e2e/.auth/state.json` (gitignored — it is a live
credential). `e2e/auth-state.ts` is the whole of it, and has **two callers and one
behaviour**: the global setup with `force`, and `shot.ts` without.

Four things there look like fussiness and are not.

**The login goes through `http://localhost:5173`, never `127.0.0.1:8787`.**
`writeSessionCookie` in `gate.ts` sets no `Domain`, so the cookie is host-only.
Logging in at the Worker's own address scopes it to `127.0.0.1`, and the page —
served from `localhost` — would never send it. The symptom is a login that
succeeds and changes nothing.

**The POST body is an object and carries an explicit `Origin`.** Hono's `csrf`
middleware challenges any unsafe request whose content-type looks like a form,
and its default when there is no content-type at all is `"text/plain"`, which
counts. An `APIRequestContext` sends no `Origin` and no `Sec-Fetch-Site`. So
`data: JSON.stringify(...)` — a string — gets a bare **403** that reads exactly
like a wrong password. Passing an object makes Playwright set
`application/json`; setting `Origin` to the `DEV_ORIGIN` from
`api/src/middleware/security.ts` makes it moot either way.

**The state file carries the session cookie AND a `localStorage` entry**, and the
second is not redundant:

> `PasswordGate` seeds its `session` state **only** from
> `localStorage["bertbooker.auth.expiresAt"]` (`app/src/lib/auth.ts`), and its one
> correcting effect handles the Worker answering `authenticated: false`. There is
> no branch for `true`. So a browser holding a perfectly valid `bertbooker_session`
> cookie and no hint falls through every check and is **shown the login dialog
> anyway**.

That is a real product bug, not a harness quirk — clear site data for
localStorage while keeping cookies, or open a fresh profile, and you are asked
for a password the server has already accepted. It costs one needless login, and
typing it re-seeds the hint. The fix would be one branch in that same effect;
until somebody makes it, **do not "simplify" the localStorage half of the seeding
away.** `e2e/auth.spec.ts` deliberately does *not* test this, because a test
would pin a bug as intended behaviour.

**Each rung names its own fix.** The helper probes `/api/health` for
`{"ok":true,"service":"bertbooker"}` before anything else — Vite has no `strictPort`
and silently hops to 5174, so without that probe a whole suite fails on every
selector against some other project's dev server. Then it asks
`/api/auth/session` whether a password is even configured, because an unset
`APP_PASSWORD` makes every route answer 503 and reporting that as a bad password
sends the reader hunting for the wrong thing. This is `gate.ts`'s own posture:
name the missing secret rather than fail vaguely.

## 5. What the fixtures watch

`e2e/fixtures.ts` exports the `test` every spec imports. A browser test that only
checks what it was told to check is a poor deal — the interesting failures happen
off to the side of the assertion. Four guards run on every test:

| guard | behaviour |
|---|---|
| uncaught exception (`pageerror`) | **always fails.** No allowlist, no opt-out. |
| `console.error` | fails, against `IGNORED_CONSOLE_ERRORS` (empty; every entry must carry a reason) |
| a **metered** endpoint was called | **always fails** |
| an external host not in the CSP | **always fails** |
| a same-origin request failed | fails, except the expected ones below |

**The metered guard is the one that costs money if it is wrong.**
`POST /api/tracked-routes/:id/search` and `.../enrich` spend real seats.aero
calls out of the 1000/day the alerts sweep also draws on (`docs/ALERTS.md` §7),
and `/__scheduled` — exposed by `--test-scheduled` in the `dev:api` script —
fires a real alert tick, ingest and email included. All three are one stray click
away on the pages under test. They are intercepted and answered 503, and touching
one fails the test.

**External hosts are an allowlist derived from the CSP** in
`api/src/middleware/security.ts`, and that is deliberate — the two lists answer the
same question and must not drift. Fonts (`fonts.googleapis.com`,
`fonts.gstatic.com`) are let through, because stubbing them changes every metric
in every screenshot. The three decorative image hosts (`images.kiwi.com`,
`icons.duckduckgo.com`, `*.basemaps.cartocdn.com`) are **fulfilled with a
transparent pixel rather than aborted** — an abort logs a failed resource and
would trip the console guard. Anything else fails the test, which turns
flake-avoidance into a real invariant.

One same-origin failure is expected and filtered by URL:

- **`/favicon.ico`** — the SPA ships none.

There used to be a second, `/daemon/*`, for a local process the SPA polled. Both
are gone; the app now talks to exactly one origin.

## 6. The suite

`e2e/pages.spec.ts` walks the three routes. **Nothing in it may depend on data
existing** — the local D1 is whatever the machine's owner last left in it, so an
assertion on a route name would pass here and fail there, which teaches everyone
to ignore the suite. Each page is identified by its own furniture:

| route | landmark | why it is safe |
|---|---|---|
| `/` | a `button` whose text is `New` or `New route` | the page has **two shapes** — an empty-state document with a contained "New route", and the workbench whose sidebar header carries an outlined "New". Exactly one exists. |
| `/library` | the `Airports` tab | from the static `LIBRARY_TABS`, rendered outside `panel()`, so it does not wait on `/api/programs` |
| `/alerts` | the `Alerts` **heading** | gated on the schedule query, so it doubles as "the API answered". `role=heading` tells it apart from the nav tab of the same name. |

Every test also asserts the Sign out button exists — when session seeding breaks,
every page fails on its landmark and the reason is nowhere in the failure; that
line puts it there.

**`getByRole(… { name })` is a trap in this codebase.** MUI's `Tooltip` puts its
title on the child as `aria-label`, so the accessible name of the Routes page's
add button is *"Track a new route"*, not *"New"*. Anything wearing a Tooltip has
the same trap — filter on text instead.

`e2e/auth.spec.ts` throws the shared session away
(`test.use({ storageState: { cookies: [], origins: [] } })`) and arrives the way a
person does: the dialog is up and the app is *not* rendered behind it, Escape
does not dismiss it (`LoginDialog` passes no `onClose`, and MUI closes only
through that callback), a wrong password is named, and the right one opens the
app. The wrong-password test is the only place in the suite that opts out of the
console guard, because provoking a 401 is its entire purpose.

`e2e/mobile.spec.ts` is the same three routes at **390×844**, under the same
no-data rule — which constrains it more than it looks, because the finds cards
and the Routes rail/editor swap both need a tracked route to exist. What it does
assert holds on an empty database:

| assertion | why it is worth a test |
|---|---|
| `scrollWidth - clientWidth <= 1` on all three routes | the document deliberately cannot scroll (`html, body, #root` are 100%), so horizontal overflow is content painted off the edge of the screen with nothing that can reach it. `PagePad`'s `overflowX: auto` is what surfaces a stray wide child *to this assertion* rather than clipping it out of sight. |
| the tab strip's right edge is left of `[data-testid="app-bar-controls"]` | this bug shipped once. The Toolbar is `overflow: visible` (that is what lets the active tab paint over the bar's bottom rule), so when the two sides stop fitting they **overlap instead of clipping**. It is geometry; measuring is the only way to see it. A fourth tab now fails a test. |
| Library's tablist is not `aria-orientation="vertical"` | the 190px column becomes a scrollable strip below `md`. MUI only emits the attribute for the vertical case, so its absence *is* the assertion. |
| Sign out and all three tabs are visible | the bar is balanced by dropping the quota chip, never the controls. |

It uses per-test `test.use({ viewport })` rather than a second Playwright
project, deliberately: `workers: 1` and `fullyParallel: false` against one shared
local D1 means a project would run everything twice, serially, for coverage these
few tests already give. `channel: "chrome"` also rules out the Mobile-Safari
device presets, since no bundled browsers are installed.

Note it is a 390px **desktop** context — nothing asks Playwright for `hasTouch`,
so the theme's `(pointer: coarse)` hit-target floors do not apply there and are
not asserted. Width and pointer are separate axes on purpose; see `COARSE` in
`app/src/theme/build.ts`.

## 7. The driver

```sh
npm run ui:shot -- --help                      # flags, and every theme id
npm run ui:shot -- --path /alerts
npm run ui:shot -- --path / --theme review     # 4 palettes
npm run ui:shot -- --path /library --click 'text=Airports' --wait '.leaflet-container'
npm run ui:shot -- --no-auth --path /          # photograph the login dialog
npm run ui:shot -- --path / --width 390 --height 844   # the phone
```

PNGs land in `e2e/.artifacts/shots/` as `<page>--<theme>.png`. It reuses the
suite's session when one is fresh and mints one when not, and runs under the same
network policy the suite does — a screenshot taken under different rules is a
picture of a different app.

**A non-default `--width` is stamped into the filename** as `--w<n>`, so a phone
shot and its desktop twin can sit in one directory. The default 1440 is *not*
stamped, so every filename that existed before is unchanged. (This is worth
knowing about because before it existed, `--width 390` silently overwrote the
1440px shot of the same page — the two pictures you most want side by side were
the two that collided.)

Comparing widths is the main way the responsive layouts get reviewed at all:
below `sm` the two finds tables stop being tables and render as cards, and no
assertion in §6 can tell you whether one *reads* well.

`--theme` seeds `bertbooker.prefs.v1` through `addInitScript` before first paint,
spread over `DEFAULT_PREFERENCES` so a preference added later cannot silently
reset here. `review` is four palettes (dark, light, a non-default light, and the
contrast outlier); `all` is the full catalog from `app/src/theme/themes.ts`, which is
also where the ids are validated against `isThemeId` — before the browser
launches, so a typo costs nothing.

**On Git Bash, quote or escape a leading-slash `--path`.** MSYS rewrites
`/alerts` into `C:/Program Files/Git/alerts` before the script ever sees it. The
project's primary shell is PowerShell, where this does not arise.

## 8. Adding a test

1. Import `test` and `expect` from `./fixtures.js`, never from
   `@playwright/test` — that skips every guard in §5.
2. Pick a landmark that exists with an empty database.
3. Keep it read-only. If it must write, clean up in `afterEach`, and remember the
   database is the one a human is also looking at.
4. Never press Search or Enrich. See §5.

## See also

- `CLAUDE.md` — orientation and invariants, in short form.
- `docs/ALERTS.md` §7 — the call budget the metered guard is protecting.
