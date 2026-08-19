import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * Every page renders, in a real browser, with a real session.
 *
 * **Nothing here may depend on data existing.** The local D1 is whatever the
 * machine's owner last left in it — often empty — so an assertion on a route
 * name or a find count would pass on one machine and fail on another, which
 * teaches the reader to ignore this suite. Each page is therefore identified by
 * a landmark that is part of the page's own furniture: a static tab, a heading,
 * a button that is always drawn.
 *
 * The `page` fixture is doing at least as much work as the assertions below —
 * it fails the test on any uncaught exception, `console.error`, failed
 * same-origin request, unexpected external host, or touch of a metered
 * endpoint. See `fixtures.ts`.
 */

interface PageCase {
  path: string;
  /** The tab that must be lit in the app bar. */
  tab: string;
  landmark: (page: Page) => ReturnType<Page["locator"]>;
  why: string;
}

const PAGES: PageCase[] = [
  {
    path: "/",
    tab: "Routes",
    // TWO SHAPES, one selector. With no tracked routes the page falls back to a
    // document with a contained "New route" button; with any, it is the
    // workbench whose sidebar header carries an outlined "New". Exactly one of
    // them exists either way, so the union is the data-independent landmark.
    //
    // Filtered on TEXT, not on the accessible name, and that is not a style
    // choice: the workbench button is wrapped in a `<Tooltip title="Track a new
    // route">`, and MUI puts the tooltip on the child as `aria-label`. So
    // `getByRole("button", { name: "New" })` matches nothing — the accessible
    // name is the tooltip. Anything in this app wearing a Tooltip has the same
    // trap.
    landmark: (page) => page.locator("button").filter({ hasText: /^New( route)?$/ }),
    why: "the add-a-route button, in whichever of the page's two shapes is drawn",
  },
  {
    path: "/library",
    tab: "Library",
    // From the static `LIBRARY_TABS` const, rendered by the page's PARENT route
    // beside the `<Outlet />` — so it does not wait on /api/programs and is
    // there even if that query fails.
    //
    // A LINK, not a tab. The sections are routes now (`/library/airports`), so
    // the nav is anchors and `role="tab"` is gone from this page entirely.
    landmark: (page) => page.getByRole("link", { name: "Airports" }),
    why: "a static section link, rendered without waiting on any query",
  },
  {
    path: "/tools",
    tab: "Tools",
    // Likewise static, and deliberately NOT the coverage tab: reaching that one
    // renders `SourceBar`, and this suite must stay as far from the metered
    // fetch as the page allows. Merely being linked costs nothing.
    landmark: (page) => page.getByRole("link", { name: "Who flies this pair?" }),
    why: "a static section link, rendered without waiting on any query",
  },
  {
    path: "/alerts",
    tab: "Alerts",
    // Gated behind the schedule query, so this one doubles as "the API
    // answered". `role=heading` is what tells it apart from the nav tab of the
    // same name.
    landmark: (page) => page.getByRole("heading", { name: "Alerts" }),
    why: "the page heading, which only renders once /api/alerts/schedule has answered",
  },
];

for (const { path, tab, landmark, why } of PAGES) {
  test(`${path} renders (${why})`, async ({ page }) => {
    await page.goto(path);

    // The shell got past the password gate. Asserted first because when the
    // session seeding breaks, EVERY page fails on its landmark and the reason
    // is nowhere in the failure — this line puts it there.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Exactly one tab is lit, and it is the right one. `/` uses
    // `activeOptions={{ exact: true }}`, so this holds on the index route too.
    //
    // Scoped to `header`, and that is not cosmetic: Library and Tools each draw
    // their own `<nav>` of TanStack links, whose open entry carries the same
    // `data-status="active"`. Unscoped this matches two anchors and `toHaveText`
    // fails on a page that is working perfectly.
    await expect(page.locator('header nav a[data-status="active"]')).toHaveText(tab);

    await expect(landmark(page)).toBeVisible();
  });
}

test("the tab strip navigates between pages", async ({ page }) => {
  await page.goto("/");
  for (const { tab, landmark } of PAGES.slice(1)) {
    // `header` for the same reason as above — the section navs are links too.
    await page.locator("header").getByRole("link", { name: tab }).click();
    await expect(landmark(page)).toBeVisible();
  }
});
