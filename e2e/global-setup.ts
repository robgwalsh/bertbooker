import { ensureAuthState } from "./auth-state.js";

/**
 * Run once before the suite: get a session, leave it in `e2e/.auth/state.json`
 * for every context to start from.
 *
 * Playwright runs `globalSetup` AFTER `webServer` has come up, which is what
 * makes it the right place for `auth-state`'s identity probe — there is a server
 * to probe by the time this runs.
 *
 * `force`, so the suite always starts on a fresh eight hours. A login is one
 * POST; a session that lapses in the middle of a run costs far more than that to
 * understand.
 */
export default async function globalSetup(): Promise<void> {
  await ensureAuthState({ force: true });
}
