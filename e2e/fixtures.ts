import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The `test` every spec imports, and the four guards it adds.
 *
 * A browser test that only asserts what it was told to assert is a poor deal:
 * the interesting failures — a thrown React error, a panel quietly rendering its
 * error state, a page that reached the internet — happen off to the side of
 * whatever the test was actually looking at. These fixtures watch that side.
 *
 * 1. **Uncaught exceptions always fail.** No allowlist, no opt-out.
 * 2. **`console.error` fails**, against a documented ignore list, opt-out per
 *    test with `test.use({ allowConsoleErrors: true })`.
 * 3. **The metered endpoints are blocked.** Touching them spends real
 *    seats.aero calls out of a shared daily budget.
 * 4. **External hosts are an allowlist derived from the CSP**, and anything not
 *    on it fails the test rather than merely being blocked.
 */

// ---------------------------------------------------------------------------
// Network policy
// ---------------------------------------------------------------------------

/**
 * The two hosts the SPA is allowed to actually reach.
 *
 * Taken from `CSP` in `workers/api/src/security.ts` — this list and that one are
 * answering the same question, so they must not drift. Fonts are let through
 * rather than stubbed because the alternative silently changes every metric in
 * every screenshot, and "the layout is wrong" is exactly the kind of finding
 * this harness exists to produce honestly.
 */
const ALLOWED_HOSTS = [
  "fonts.googleapis.com", // the Inter stylesheet in web/index.html
  "fonts.gstatic.com", // the font files it points at
];

/**
 * Hosts that are stubbed rather than blocked.
 *
 * All three are decoration: carrier logos, program icons, map tiles. Letting
 * them out makes a run depend on three third parties being up and quick;
 * *aborting* them would fill the console with failed-resource errors and defeat
 * guard 2. So they are fulfilled with a transparent pixel and nobody notices.
 */
const STUBBED_HOSTS = [
  /^images\.kiwi\.com$/, // carrier logos (web/src/ui.tsx)
  /^icons\.duckduckgo\.com$/, // program/site icons (web/src/ui.tsx)
  /\.basemaps\.cartocdn\.com$/, // the airports map's tiles (web/src/AirportMap.tsx)
];

/** 1x1 transparent GIF. */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * The requests that cost money.
 *
 * Search and enrich both call seats.aero's Partner API, metered at 1000/day and
 * shared with the alerts sweep's budget (`docs/ALERTS.md` §7). `/__scheduled` is
 * exposed by `--test-scheduled` in the `dev:api` script and fires a REAL alert
 * tick — a sweep, an ingest, and an email.
 *
 * None of these is something a UI test needs, and all three are one stray click
 * away in the pages under test. Blocked, and loudly.
 */
const METERED_PATTERNS: RegExp[] = [
  /\/api\/tracked-routes\/[^/]+\/search/,
  /\/api\/tracked-routes\/[^/]+\/enrich/,
  /\/__scheduled/,
];

/**
 * `console.error` messages that are noise rather than signal.
 *
 * Starts empty on purpose. Every entry added here must carry a comment saying
 * why the app is allowed to log it, because the alternative — a growing list of
 * shrugs — turns guard 2 back off one line at a time.
 */
const IGNORED_CONSOLE_ERRORS: RegExp[] = [];

/**
 * Same-origin requests that are SUPPOSED to fail, and must not read as a broken
 * page. Everything else same-origin still does.
 *
 * `/favicon.ico` — the SPA ships none, so Chrome asks and gets the SPA fallback.
 * Cosmetic, and nothing to do with the page under test.
 *
 * There was a second entry, `/daemon/*`, for the local runner's health poll.
 * Both the daemon and the tab that polled it are gone; the SPA now talks to
 * exactly one origin.
 */
const EXPECTED_FAILURES: RegExp[] = [/^\/favicon\.ico$/];

/** Does this URL belong to something we already know answers badly? */
function isExpectedFailure(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isLocal(url) && EXPECTED_FAILURES.some((re) => re.test(url.pathname));
  } catch {
    return false;
  }
}

const isLocal = (url: URL): boolean =>
  url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

/** Everything the guards collected during one test. */
interface Violations {
  pageErrors: string[];
  consoleErrors: string[];
  metered: string[];
  foreignHosts: Set<string>;
  failedRequests: string[];
}

/**
 * Install the network policy on a page.
 *
 * Exported because `shot.ts` uses it too: a screenshot taken under a different
 * network policy than the suite runs under is a screenshot of a different app.
 * `onViolation` is how the two callers differ — the suite fails a test, the
 * screenshot driver just prints.
 */
export async function applyNetworkPolicy(
  page: Page,
  sink: { metered: string[]; foreignHosts: Set<string> },
  opts: { online?: boolean } = {},
): Promise<void> {
  // Registered first and matching only same-origin paths, so it can never
  // overlap with the external-host route below.
  await page.route(
    (url) => isLocal(url) && METERED_PATTERNS.some((re) => re.test(url.pathname)),
    async (route) => {
      sink.metered.push(route.request().url());
      // 503 rather than abort: the SPA renders a named failure for it, which is
      // a far calmer page than a dead fetch, and it keeps the console quiet.
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "blocked_by_e2e_quota_guard" }),
      });
    },
  );

  if (opts.online) return;

  await page.route(
    (url) => !isLocal(url),
    async (route) => {
      const host = new URL(route.request().url()).hostname;
      if (ALLOWED_HOSTS.includes(host)) return route.continue();
      if (STUBBED_HOSTS.some((re) => re.test(host))) {
        return route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL });
      }
      // Not in the CSP, so the SPA has started talking to something nobody
      // wrote down. Record it and answer blandly.
      sink.foreignHosts.add(host);
      return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
    },
  );
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export const test = base.extend<{
  /** Let this spec log `console.error` without failing. Use sparingly, and say
   *  why at the call site. */
  allowConsoleErrors: boolean;
  /** Let this spec reach the real internet. Off everywhere in the suite. */
  online: boolean;
}>({
  allowConsoleErrors: [false, { option: true }],
  online: [false, { option: true }],

  page: async ({ page, allowConsoleErrors, online }, use) => {
    const v: Violations = {
      pageErrors: [],
      consoleErrors: [],
      metered: [],
      foreignHosts: new Set(),
      failedRequests: [],
    };

    page.on("pageerror", (err) => v.pageErrors.push(err.stack ?? err.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (IGNORED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
      // A failed-resource message is attributed to the resource, not to the
      // script — which is what lets the expected failures above be filtered by
      // URL rather than by matching on Chrome's wording.
      if (isExpectedFailure(msg.location().url)) return;
      v.consoleErrors.push(text);
    });
    page.on("requestfailed", (req) => {
      const url = new URL(req.url());
      // Only same-origin: an external host we deliberately stubbed is not a
      // failure, and `route.fulfill` means it never reaches here anyway.
      if (!isLocal(url)) return;
      if (METERED_PATTERNS.some((re) => re.test(url.pathname))) return;
      if (isExpectedFailure(req.url())) return;
      v.failedRequests.push(`${req.url()} — ${req.failure()?.errorText ?? "unknown"}`);
    });

    await applyNetworkPolicy(page, v, { online });

    await use(page);

    // Assert AFTER the test body, so a test that failed on its own assertion
    // reports that first and these only add to the picture.
    expect(v.pageErrors, "uncaught exception in the page").toEqual([]);
    expect(
      v.metered,
      "the page called a METERED seats.aero endpoint — that spends real quota",
    ).toEqual([]);
    expect(
      [...v.foreignHosts],
      "the SPA reached an external host that is not in the CSP allowlist in workers/api/src/security.ts",
    ).toEqual([]);
    expect(v.failedRequests, "a same-origin request failed").toEqual([]);
    if (!allowConsoleErrors) {
      expect(v.consoleErrors, "console.error in the page").toEqual([]);
    }
  },
});

export { expect };
