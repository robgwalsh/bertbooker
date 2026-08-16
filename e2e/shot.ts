import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { THEMES, isThemeId, themeGroup } from "../web/src/themes.js";
import { DEFAULT_PREFERENCES } from "../web/src/preferences.js";
import { BASE_URL, STATE_PATH, ensureAuthState } from "./auth-state.js";
import { applyNetworkPolicy } from "./fixtures.js";

/**
 * Go to a page, optionally click through it, and write a PNG.
 *
 * The companion to the spec suite, for the times when the question is not "does
 * this still work" but "what does this look like right now" — a question an
 * agent cannot otherwise answer at all, and which a human answers by alt-tabbing
 * to a browser. It is deliberately not a test: no assertions, no exit code to
 * interpret, just an image on disk.
 *
 * **Headless and ephemeral, and it must stay both.** There is no anti-bot on the
 * Vite dev server, so a browser with no window at all — one that cannot be
 * clicked on, focused, or covered by whatever the machine's owner is doing — is
 * strictly better than a real one. And a *persistent* context locks its
 * directory, which would make two screenshots taken at once mutually exclusive
 * for no gain: there is no reputation to accumulate against localhost.
 *
 * So: `launch` + `newContext`, never `launchPersistentContext`. And never
 * `page.bringToFront()`, which raises a window.
 */

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  path: string;
  url?: string;
  themes: string[];
  out: string;
  full: boolean;
  waits: string[];
  clicks: string[];
  width: number;
  height: number;
  online: boolean;
  console: boolean;
  auth: boolean;
  show: boolean;
  settleMs: number;
}

/**
 * A small, opinionated set for looking at a change across palettes.
 *
 * Four rather than all twenty-one because the point is to catch a palette-shaped
 * mistake, and a mistake that survives dark, light and the contrast outlier is
 * not palette-shaped. `--theme all` is there when it is.
 */
const REVIEW_THEMES = ["dark-plus", "light-plus", "solarized-light", "high-contrast-dark"];

/** The desktop width, and the one that does NOT get stamped into a filename —
 *  see the `--w` suffix where the name is built. Matches `playwright.config.ts`,
 *  so a driver shot and a suite screenshot frame the same app. */
const DEFAULT_WIDTH = 1440;

function usage(): never {
  const byGroup = new Map<string, string[]>();
  for (const spec of THEMES) {
    const group = themeGroup(spec);
    byGroup.set(group, [...(byGroup.get(group) ?? []), spec.id]);
  }
  console.error(`
Screenshot a page of the running app.

  npm run ui:shot -- --path /alerts
  npm run ui:shot -- --path / --theme review
  npm run ui:shot -- --path /library --click 'text=Airports' --wait '.leaflet-container'

  --path <p>        client route to visit          (default /)
  --url <abs>       absolute URL instead of --path
  --theme <ids>     comma list, or 'review' (${REVIEW_THEMES.length}) or 'all' (${THEMES.length}).
                    Default: whatever the stored preference already is.
  --out <dir>       output directory                (default e2e/.artifacts/shots)
  --full            full-page rather than viewport
  --wait <sel>      wait for a selector; repeatable, applied in order
  --click <sel>     click a selector; repeatable, applied in order
  --width <n>       viewport width                  (default ${DEFAULT_WIDTH})
                    anything else is stamped into the filename as --w<n>,
                    so a phone shot cannot overwrite its desktop twin
  --height <n>      viewport height                 (default 900)
  --settle <ms>     extra pause before the shutter  (default 600)
  --online          allow real external requests (faithful logos and map tiles)
  --console         print console messages and page errors
  --no-auth         skip the session, to photograph the login dialog
  --show            run HEADED. Opens a window and takes focus — for a human at
                    the keyboard only; an agent must never pass this.

Themes:
${[...byGroup].map(([g, ids]) => `  ${g}: ${ids.join(", ")}`).join("\n")}
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    path: "/",
    themes: [],
    out: resolve(process.cwd(), "e2e/.artifacts/shots"),
    full: false,
    waits: [],
    clicks: [],
    width: DEFAULT_WIDTH,
    height: 900,
    online: false,
    console: false,
    auth: true,
    show: false,
    settleMs: 600,
  };
  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${flag} needs a value`);
      process.exit(1);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        usage();
      case "--path":
        a.path = next(i, arg);
        i++;
        break;
      case "--url":
        a.url = next(i, arg);
        i++;
        break;
      case "--theme":
        a.themes = next(i, arg)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i++;
        break;
      case "--out":
        a.out = resolve(process.cwd(), next(i, arg));
        i++;
        break;
      case "--wait":
        a.waits.push(next(i, arg));
        i++;
        break;
      case "--click":
        a.clicks.push(next(i, arg));
        i++;
        break;
      case "--width":
        a.width = Number(next(i, arg));
        i++;
        break;
      case "--height":
        a.height = Number(next(i, arg));
        i++;
        break;
      case "--settle":
        a.settleMs = Number(next(i, arg));
        i++;
        break;
      case "--full":
        a.full = true;
        break;
      case "--online":
        a.online = true;
        break;
      case "--console":
        a.console = true;
        break;
      case "--no-auth":
        a.auth = false;
        break;
      case "--show":
        a.show = true;
        break;
      default:
        console.error(`unknown flag: ${arg}`);
        usage();
    }
  }

  // Expand and validate the theme list before launching anything — a typo
  // should cost nothing and say what the options were.
  if (a.themes.length === 1 && a.themes[0] === "all") a.themes = THEMES.map((t) => t.id);
  else if (a.themes.length === 1 && a.themes[0] === "review") a.themes = [...REVIEW_THEMES];
  const unknown = a.themes.filter((id) => !isThemeId(id));
  if (unknown.length) {
    console.error(`unknown theme id(s): ${unknown.join(", ")}`);
    usage();
  }
  return a;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** `/` → `root`, `/library` → `library`, `/a/b?c=1` → `a-b-c-1`. */
function slug(path: string): string {
  const s = path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return s || "root";
}

async function capture(
  context: BrowserContext,
  args: Args,
  themeId: string | null,
): Promise<string> {
  const page: Page = await context.newPage();

  if (args.console) {
    page.on("console", (m) => console.error(`  · console.${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => console.error(`  ! pageerror: ${e.message}`));
  }

  // The same network policy the suite runs under, so a screenshot is a picture
  // of the app the tests saw rather than of a different one.
  await applyNetworkPolicy(page, { metered: [], foreignHosts: new Set() }, { online: args.online });

  if (themeId) {
    // Spread over DEFAULT_PREFERENCES rather than writing a two-key literal, so
    // adding a preference later cannot silently reset it here to whatever the
    // parser's per-field fallback happens to be.
    const blob = JSON.stringify({ ...DEFAULT_PREFERENCES, themeId });
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key!, value!),
      ["bertbooker.prefs.v1", blob] as const,
    );
  }

  await page.goto(args.url ?? `${BASE_URL}${args.path}`, { waitUntil: "domcontentloaded" });

  for (const selector of args.clicks) {
    await page.locator(selector).first().click({ timeout: 10_000 });
  }
  for (const selector of args.waits) {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 });
  }

  // MUI transitions, React Query's first paint, and the theme swap all land
  // within a few hundred ms of each other. Cheaper and more honest than
  // `networkidle`, which never settles on a page that polls.
  await page.waitForTimeout(args.settleMs);

  mkdirSync(args.out, { recursive: true });
  // The WIDTH is part of the filename whenever it isn't the default, because
  // comparing a phone against a desktop means having both at once — and without
  // this, `--width 390` silently overwrote the 1440px shot of the same page in
  // the same directory. Omitted at the default so every existing filename, and
  // every path written down in a doc, stays exactly what it was.
  const width = args.width === DEFAULT_WIDTH ? "" : `--w${args.width}`;
  const name = `${slug(args.url ?? args.path)}${themeId ? `--${themeId}` : ""}${width}.png`;
  const file = resolve(args.out, name);
  await page.screenshot({ path: file, fullPage: args.full });
  await page.close();
  return file;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.show) {
  console.error(
    "note: --show runs HEADED. A window will open and take focus. Never pass this from an agent.",
  );
}

let storageState: string | undefined;
if (args.auth) {
  await ensureAuthState({});
  storageState = STATE_PATH;
}

const browser = await chromium.launch({ channel: "chrome", headless: !args.show });
try {
  const context = await browser.newContext({
    storageState,
    baseURL: BASE_URL,
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
    // Pinned for the same reason playwright.config.ts pins them: the app
    // formats dates through `toLocaleString`, and a screenshot that moves with
    // the machine's locale is not comparable with itself.
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  // No theme named means "leave the stored preference alone", which is a real
  // and useful case: it photographs the app as this browser profile has it.
  const themes: (string | null)[] = args.themes.length ? args.themes : [null];
  for (const themeId of themes) {
    const file = await capture(context, args, themeId);
    console.log(file);
  }
} finally {
  await browser.close();
}
