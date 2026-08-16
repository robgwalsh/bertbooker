import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.js";

/**
 * The front door itself.
 *
 * Every other spec starts already signed in, from the `storageState` that
 * `global-setup.ts` writes. This one throws that away and arrives the way a
 * person does, because the gate is the one piece of this app where "it renders"
 * and "it works" are genuinely different claims: a gate that draws a convincing
 * password box and lets anyone through looks identical from the outside.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** The same secret the harness logs in with, read the same way — see the
 *  docblock on `parseDevVars` in `auth-state.ts` for why the split is on the
 *  first `=` only. Duplicated rather than exported because a spec reaching into
 *  the setup helper's internals is how the two quietly grow apart. */
function appPassword(): string {
  const override = process.env.BERTBOOKER_APP_PASSWORD;
  if (override) return override;
  const path = resolve(process.cwd(), "workers/api/.dev.vars");
  if (!existsSync(path)) throw new Error(`no ${path} — cannot test the login`);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq).trim() === "APP_PASSWORD") {
      return trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, "$1");
    }
  }
  throw new Error("no APP_PASSWORD line in workers/api/.dev.vars");
}

test("a fresh visit is locked, and the app is not rendered behind the dialog", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("dialog")).toContainText("Enter the shared password");

  // The point of the assertion: not merely that a dialog is on top, but that
  // there is nothing underneath it. `PasswordGate` renders an empty backdrop
  // rather than the app, so none of the shell exists yet.
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.locator("nav a")).toHaveCount(0);
});

test("the dialog cannot be dismissed without a password", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();

  // `LoginDialog` passes no `onClose`, and MUI closes only through that
  // callback — so Escape and a backdrop click have nowhere to go. Pinned
  // because "make the dialog closeable" is a plausible-looking change that
  // would quietly put an unauthenticated app on screen.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
});

// The one test in the suite that is SUPPOSED to be refused. Chrome logs every
// 401 to the console as a failed resource, so the guard would fail a test whose
// entire purpose is provoking that 401. Opted out here and nowhere else, rather
// than added to `IGNORED_CONSOLE_ERRORS`, which would blind the whole suite to
// unauthorized calls.
test.describe(() => {
  test.use({ allowConsoleErrors: true });

  test("a wrong password is refused, by name", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Unlock" }).click();

    // `gate.ts` spends a deliberate 250ms on a bad password
    // (BAD_PASSWORD_DELAY_MS), which the default expect timeout covers.
    await expect(page.getByRole("alert")).toContainText("That password isn't right.");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

test("the right password opens the app", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Password").fill(appPassword());
  await page.getByRole("button", { name: "Unlock" }).click();

  // Await the SHELL, not a settled screen. This is the one path that fires
  // `QuotaSplash` — `handleSuccess` sets `splash`, which a storageState-seeded
  // session never does — so there is an animation in flight here and any
  // screenshot-shaped assertion would be racing it.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.locator('nav a[data-status="active"]')).toHaveText("Routes");
});
