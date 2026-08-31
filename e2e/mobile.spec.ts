import { expect, test } from "./fixtures.js";

/**
 * The app on a phone.
 *
 * Same rules as `pages.spec.ts` — **nothing here may depend on data existing**,
 * because the local D1 is whatever the machine's owner last left in it. That
 * constrains this file more than it looks: the finds cards and the rail/editor
 * swap both need at least one tracked route, so neither is asserted here. What
 * IS asserted is the set of things that hold on an empty database, and between
 * them plus the `page` fixture's exception and `console.error` guards they cover
 * the failure modes that actually matter — a page that renders too wide, a bar
 * that overlaps itself, and a card branch that throws.
 *
 * **Per-test `test.use({ viewport })`, deliberately not a second Playwright
 * project.** The config is `workers: 1, fullyParallel: false` against one shared
 * local D1, so a project would run the whole suite twice serially for coverage
 * this file gets in four tests. `channel: "chrome"` also rules out the
 * Mobile-Safari device presets — no bundled browsers are installed.
 *
 * Note this is a 390px *desktop* context: Playwright is not asked for
 * `hasTouch`, so the theme's `(pointer: coarse)` hit-target floors do not apply
 * here. That is on purpose — they are a separate axis from width, and asserting
 * them would pin an emulation detail rather than the app.
 */

const PHONE = { width: 390, height: 844 };

/** Every route, so a page that overflows is caught wherever it lives. */
const PATHS = ["/", "/library", "/tools", "/alerts"];

test.describe("at 390px", () => {
  test.use({ viewport: PHONE });

  for (const path of PATHS) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.goto(path);
      // The single highest-value mobile assertion available without data. The
      // document deliberately cannot scroll (`html, body, #root` are 100%), so
      // horizontal overflow here is not "a bit wide" — it is content painted
      // off the edge of the screen with no scrollbar anywhere that can reach
      // it. One pixel of slack for sub-pixel layout rounding.
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement!;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow, `${path} overflows horizontally at ${PHONE.width}px`).toBeLessThanOrEqual(
        1,
      );
    });
  }

  test("the tab strip does not run under the app-bar controls", async ({ page }) => {
    await page.goto("/");
    // The bug this pins actually shipped: the Toolbar is `overflow: visible`
    // (which is what lets the active tab paint over the bar's bottom rule), so
    // when the two sides stop fitting they OVERLAP rather than clip — the quota
    // chip landed on top of the last tab. It is geometry, so measuring the
    // two boxes is the only way to see it. It is the gate a new tab has to get
    // past, instead of the failure being something a person has to notice —
    // Tools went in under it, which is why that label is the shortest on the
    // bar.
    const nav = await page.locator("header nav").boundingBox();
    const controls = await page.getByTestId("app-bar-controls").boundingBox();
    expect(nav, "the tab strip should be laid out").not.toBeNull();
    expect(controls, "the app-bar controls should be laid out").not.toBeNull();
    expect(
      nav!.x + nav!.width,
      "the tabs run under the app-bar controls — the bar has stopped fitting",
    ).toBeLessThanOrEqual(controls!.x + 1);
  });

  for (const path of ["/library", "/tools"]) {
    test(`${path}'s section nav is a horizontal strip, not a 190px column`, async ({ page }) => {
      await page.goto(path);
      const nav = page.getByTestId("section-nav");
      await expect(nav).toBeVisible();
      const box = await nav.boundingBox();
      expect(box, "the section nav should be laid out").not.toBeNull();
      expect(
        box!.width,
        `${path}'s section nav is still a column at ${PHONE.width}px`,
      ).toBeGreaterThan(300);
    });
  }

  test("the shell is intact", async ({ page }) => {
    await page.goto("/");
    // Sign out survives at every width — the bar is balanced by dropping the
    // quota chip, not the controls. `pages.spec.ts` asserts the same thing at
    // 1440; this is the half that would break first if that ever changed.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // All four tabs still reachable at 390 — none is scrolled out or covered.
    // The dev and deployed bars carry the same four; this is the whole strip.
    // Scoped to `header`: the section navs are links too, and "Library" would
    // otherwise be ambiguous the moment one of those pages is open.
    for (const tab of ["Routes", "Library", "Tools", "Alerts"]) {
      await expect(page.locator("header").getByRole("link", { name: tab })).toBeVisible();
    }
  });
});
