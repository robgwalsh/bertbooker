import { defineConfig } from "@playwright/test";

/**
 * The UI harness: drive the real SPA in a real browser, with nobody at the
 * keyboard.
 *
 * This exists because the web workspace runs vitest in Node with no DOM, so
 * nothing in `npm test` has ever rendered a component. A thrown React error, a
 * blank pane, a page that loads to a wall of failed panels — all of them are
 * invisible until a human opens a browser. This is how they stop being.
 *
 * **It must be impossible to disturb.** Whoever owns this machine is usually
 * working in other applications while a run happens, so:
 *
 * - `headless: true`. No window, no OS focus, no taskbar entry: clicks,
 *   Alt-Tabs and window drags cannot reach it and it cannot steal focus.
 *   Screenshots come from the renderer over CDP, not from the screen, so
 *   whatever is on top of the desktop never lands in an image.
 * - `reuseExistingServer`. A dev pair that is already up is attached to and left
 *   alone — not restarted, and not killed on the way out.
 * - `open: "never"` on the reporter, below. The default pops a browser window at
 *   whoever is at the keyboard, which is precisely the interruption this file
 *   exists to avoid.
 *
 * Headless and ephemeral, and both must stay that way. There is no anti-bot on
 * localhost, so a browser with no window strictly wins; and a persistent context
 * locks its directory, so two runs could not overlap. See docs/UI-TESTING.md §2.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./e2e/.artifacts/test-results",
  globalSetup: "./e2e/global-setup.ts",

  // ONE worker. Both servers and the local D1 (`--persist-to .wrangler-local`)
  // are a single shared instance, and this suite reads the same database a human
  // is looking at — parallel workers would interleave against one sqlite file.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },

  // No `.only` left behind in a committed spec.
  forbidOnly: true,

  reporter: [
    ["list"],
    // `open: "never"` is not cosmetic — see the docblock above.
    ["html", { outputFolder: "./e2e/.artifacts/report", open: "never" }],
  ],

  use: {
    // `localhost`, NOT `127.0.0.1`: Vite binds IPv6 here (CLAUDE.md's addressing
    // gotcha), and it is also the host the session cookie is scoped to.
    baseURL: "http://localhost:5173",

    // The Chrome already installed on this machine. Nothing is ever downloaded:
    // `@playwright/test` is installed with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1,
    // and this channel resolves the real browser. If a launch ever fails here
    // the fix is to install Chrome — NOT `npx playwright install`, which fetches
    // a bundled Chromium this config will never use.
    channel: "chrome",
    headless: true,

    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // The app formats dates through `toLocaleString`, so both of these have to
    // be pinned or a screenshot taken in March disagrees with one taken in June
    // for reasons that have nothing to do with the code.
    locale: "en-US",
    timezoneId: "America/Los_Angeles",

    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,

    // Written by `e2e/global-setup.ts`. Carries the session cookie AND a
    // localStorage hint, and the second one is not redundant — see the comment
    // in `auth-state.ts`.
    storageState: "./e2e/.auth/state.json",
  },

  // The standard dev pair, started through the SAME root scripts a human uses.
  // Never an inlined `wrangler dev`: `workers/api` deliberately has no `dev`
  // script because a second launch path would duplicate the port and the persist
  // path, and this would be that second path.
  //
  // `reuseExistingServer` is what makes a run safe to fire while somebody is
  // working: if these are already up, Playwright starts nothing and kills
  // nothing. When it DOES start the API, `predev:api` (scripts/free-port.mjs)
  // clears a wedged 8787 first — and that only runs when the port wasn't
  // answering, so it can never take down a healthy server someone is using.
  webServer: [
    {
      command: "npm run dev:api",
      // 127.0.0.1, because wrangler binds IPv4 — the mirror image of `baseURL`.
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npm run dev:web",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
