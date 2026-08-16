import { defineConfig } from "vitest/config";

/**
 * One vitest run for the whole repo.
 *
 * This replaced four per-workspace `vitest run` invocations when the packages
 * were collapsed into `api/`, `app/` and `shared/`. A single flat project is
 * enough because **every test here runs in Node with no DOM** — the app's tests
 * are pure logic (preferences parsing, theme contrast, round-trip pairing, the
 * find key) and `parsePreferences` deliberately takes a raw string rather than
 * reading `localStorage` so it stays testable without jsdom.
 *
 * `e2e/` is excluded by the include pattern rather than by an exclude rule: its
 * files are `*.spec.ts` and belong to Playwright (`npm run test:ui`), which
 * needs two live servers and a real Chrome. Nothing in here touches a network
 * or a server.
 */
export default defineConfig({
  test: {
    include: ["{shared,api,app}/src/**/*.test.ts"],
  },
});
