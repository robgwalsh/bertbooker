import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

/**
 * Getting the harness past the front door, once.
 *
 * The app is behind a shared-password gate (`api/src/middleware/gate.ts`), so every
 * page a test looks at is eight hours of session cookie away from existing. This
 * module performs that login exactly once per run and leaves the result in a
 * `storageState` file the browser contexts are seeded from.
 *
 * **Two callers and one behaviour**, in the shape the ingest pipeline uses:
 * `global-setup.ts` calls it with `force` before the suite, and `shot.ts` calls
 * it without so an ad-hoc screenshot reuses a session that is still good.
 *
 * Everything fallible happens in a fixed order, and each rung names its own
 * fix — the same posture `gate.ts` takes when it answers `no_app_password`
 * instead of waving traffic through. A harness that fails as "timeout waiting
 * for selector" when the real problem is an unset password teaches nobody
 * anything.
 */

/** Where the seeded session lands. A LIVE credential for the local API — kept
 *  out of git by the `e2e/.auth/` line in `.gitignore`. */
export const STATE_PATH = resolve(process.cwd(), "e2e/.auth/state.json");

/**
 * The origin everything goes through, and it is not negotiable.
 *
 * `writeSessionCookie` (`gate.ts`) sets no `Domain`, so the cookie is host-only.
 * Logging in against `127.0.0.1:8787` would scope it to `127.0.0.1` and the page
 * — served from `localhost:5173` — would never send it, producing a login that
 * succeeds and changes nothing. Cookies ignore the port, so one login here works
 * for the Vite server and the Worker alike.
 *
 * `localhost` rather than `127.0.0.1` for the second reason in CLAUDE.md's
 * addressing gotcha: Vite binds IPv6 here, and `127.0.0.1:5173` is refused.
 */
export const BASE_URL = "http://localhost:5173";

/** The Worker's copy of the secrets. NOT the repo-root `.env`, which is the
 *  local runner's and which `workerd` never sees. */
const DEV_VARS = resolve(process.cwd(), "api/.dev.vars");

/** Re-login rather than reuse a session with less than this left on it, so a
 *  long suite can't lapse halfway through. */
const MIN_REMAINING_SECONDS = 30 * 60;

/**
 * Read `api/.dev.vars` into a plain map.
 *
 * Split on the FIRST `=` only — a base64url `SESSION_SECRET` can contain one —
 * and drop comments and blanks, because the real file interleaves both.
 */
function parseDevVars(): Record<string, string> {
  if (!existsSync(DEV_VARS)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(DEV_VARS, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Is the BertBooker SPA — and not some other project — answering on :5173?
 *
 * Vite has no `strictPort`, so it hops to 5174 without saying so when something
 * else owns the port. Without this probe the symptom is a suite that fails on
 * every selector against a stranger's app, which reads as "the UI is broken".
 * `/api/health` is outside the gate (`api/src/index.ts`) and its body
 * names the service, so one request answers both "is anything there" and "is it
 * ours".
 */
async function assertBertBookerIsServing(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/health`);
  } catch (err) {
    throw new Error(
      `nothing answered ${BASE_URL}/api/health (${err instanceof Error ? err.message : String(err)}).\n` +
        `Start the app first:  npm run dev:api   and   npm run dev:app\n` +
        `If both ARE running, :8787 is probably wedged — that looks like a hang rather\n` +
        `than a refusal on Windows. Fix with:  npm run dev:api:stop`,
    );
  }
  const body = (await res.json().catch(() => null)) as { service?: string } | null;
  if (!res.ok || body?.service !== "bertbooker") {
    throw new Error(
      `something other than the BertBooker app is answering on ${BASE_URL}.\n` +
        `Got HTTP ${res.status} ${JSON.stringify(body)}.\n` +
        `Vite silently hops to :5174 when :5173 is taken, so this is usually another\n` +
        `project's dev server holding the port.`,
    );
  }
}

/** Does the state file still hold a session worth reusing? */
function stateIsFresh(): boolean {
  if (!existsSync(STATE_PATH)) return false;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
      cookies?: { name: string; expires?: number }[];
    };
    const session = state.cookies?.find((c) => c.name === "bertbooker_session");
    if (!session?.expires || session.expires < 0) return false;
    return session.expires - Date.now() / 1000 > MIN_REMAINING_SECONDS;
  } catch {
    // A half-written or hand-edited file means "assume nothing", never a throw.
    return false;
  }
}

export interface EnsureAuthOptions {
  /** Log in even if the stored session is still good. `global-setup` does. */
  force?: boolean;
}

/**
 * Produce `e2e/.auth/state.json`, and return its path.
 */
export async function ensureAuthState(opts: EnsureAuthOptions = {}): Promise<string> {
  if (!opts.force && stateIsFresh()) return STATE_PATH;

  await assertBertBookerIsServing();

  // Ask before guessing. An unset APP_PASSWORD makes every /api/* route answer
  // 503, and reporting that as a wrong password would send whoever is reading
  // hunting for the wrong thing entirely.
  const sessionRes = await fetch(`${BASE_URL}/api/auth/session`);
  const session = (await sessionRes.json()) as { configured: boolean; reason?: string };
  if (!session.configured) {
    throw new Error(
      `the API has no ${session.reason === "no_session_secret" ? "SESSION_SECRET" : "APP_PASSWORD"} configured, ` +
        `so no password can work.\nAdd it as a line in api/.dev.vars and restart ` +
        `npm run dev:api (wrangler does not reload that file).`,
    );
  }

  const password = process.env.BERTBOOKER_APP_PASSWORD ?? parseDevVars().APP_PASSWORD;
  if (!password) {
    throw new Error(
      `no APP_PASSWORD found.\nExpected a line in ${DEV_VARS}, or BERTBOOKER_APP_PASSWORD in the environment.`,
    );
  }

  mkdirSync(dirname(STATE_PATH), { recursive: true });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ baseURL: BASE_URL });

    // Two details here are load-bearing and both look like noise:
    //
    // `data` is an OBJECT, not a JSON string. Playwright sets
    // `content-type: application/json` for an object, and hono's `csrf`
    // middleware only challenges requests whose content-type looks like a form
    // — with `|| "text/plain"` as the default, so a body with NO content-type
    // counts as form-ish and gets a bare 403 that reads exactly like a bad
    // password.
    //
    // `Origin` is set explicitly because an APIRequestContext sends none, and
    // it is the `DEV_ORIGIN` in api/src/middleware/security.ts. Belt to the braces
    // above: with it, the content-type no longer matters.
    const res = await context.request.post("/api/auth/login", {
      data: { password },
      headers: { Origin: BASE_URL },
    });

    if (!res.ok()) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `login failed: HTTP ${res.status()} ${body}\n` +
          (body.includes("bad_password")
            ? `wrangler dev does NOT reload .dev.vars — if you just changed APP_PASSWORD, restart npm run dev:api.`
            : ``),
      );
    }
    const { expiresAt } = (await res.json()) as { expiresAt: number };

    // The cookie alone is NOT enough, and this is the single least obvious thing
    // in the harness. `PasswordGate` seeds its `session` state only from
    // `localStorage["bertbooker.auth.expiresAt"]` (app/src/lib/auth.ts), and its one
    // correcting effect handles the server answering `authenticated: false` —
    // there is no branch for `true`. So a browser holding a perfectly valid
    // cookie and no hint falls all the way through to the login dialog. Seeding
    // both halves is the workaround; see docs/UI-TESTING.md §4.
    const page = await context.newPage();
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key!, value!),
      ["bertbooker.auth.expiresAt", String(expiresAt)] as const,
    );
    await page.goto("/");
    await context.storageState({ path: STATE_PATH });
    await context.close();
  } finally {
    await browser.close();
  }

  return STATE_PATH;
}
