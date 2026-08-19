import { test, expect } from "./fixtures.js";

/**
 * The Tools page — the three surfaces over the seats.aero route graph.
 *
 * Everything asserted here has to hold against an EMPTY database — no tracked
 * routes, no fetched sources — so nothing below looks for a route row or a
 * graph. What it does check is the distinction the page exists for: an
 * unfetched source must read as "not fetched", never as "flies nowhere".
 *
 * **Nothing here may select a source in the dropdown.** Picking a program that
 * has never been fetched fetches it, which is a real seats.aero call;
 * `fixtures.ts` fails any test that reaches `/api/seatsaero/sources/:source/
 * fetch`, and it is in `METERED_PATTERNS` for exactly this spec. Opening the
 * coverage tab is free by design — the auto-fetch fires on an explicit
 * selection, never on mount — and that is the property these tests are allowed
 * to lean on.
 *
 * Each test navigates straight to its section's URL. That is the whole point of
 * the sections being routes: no click-through to set up, and a failure names the
 * page it happened on.
 */
test.describe("Tools", () => {
  test("lands on a section rather than an empty page", async ({ page }) => {
    await page.goto("/tools");
    // `/tools` redirects to the first section, so the bare path is never a
    // blank pane — and the app bar's Tools tab stays lit through the redirect,
    // because its match is a prefix match.
    await expect(page).toHaveURL(/\/tools\/tracked-routes$/);
    await expect(page.getByRole("heading", { name: "Validate Routes" })).toBeVisible();
  });

  test("each section has its own URL", async ({ page }) => {
    for (const [path, heading] of [
      ["/tools/tracked-routes", "Validate Routes"],
      ["/tools/coverage", "Data coverage"],
      ["/tools/pair-lookup", "Who flies this pair?"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("the section nav does not move when you change sections", async ({ page }) => {
    // A sticky offset is measured from its SCROLLER, and `PagePad` is both the
    // scroller and the thing that supplies the page margin — so any `top` on the
    // nav counts that margin twice (`STICKY_NAV_TOP`). The symptom is subtle and
    // was shipped: a sticky box cannot be pushed past the bottom of its
    // containing block, so the offset only applies on a section whose content is
    // TALLER than the nav. Tools is where that shows, because "Who flies this
    // pair?" is short and "Data coverage" is not — switching between them moved
    // the nav 20px.
    //
    // Geometry, and across sections rather than against a number: what matters
    // is that the nav holds still, not where it happens to sit.
    const tops: number[] = [];
    for (const path of ["/tools/tracked-routes", "/tools/coverage", "/tools/pair-lookup"]) {
      await page.goto(path);
      const box = await page.getByTestId("section-nav").boundingBox();
      expect(box, `the section nav should be laid out on ${path}`).not.toBeNull();
      tops.push(Math.round(box!.y));
    }
    expect(new Set(tops).size, `the section nav shifts between sections: ${tops.join(", ")}`).toBe(
      1,
    );
  });

  test("an unknown section falls back rather than rendering nothing", async ({ page }) => {
    // `$tab` is untrusted input like any other piece of a URL. The house rule is
    // that invalid values fall back to a default, never to an empty pane.
    await page.goto("/tools/not-a-tool");
    await expect(page.getByRole("heading", { name: "Validate Routes" })).toBeVisible();
  });

  test("offers a refresh control without spending anything to show it", async ({ page }) => {
    await page.goto("/tools/coverage");
    // Present on arrival, and merely arriving costs nothing — see the note
    // above. Not pressed: it is the one control on this page that spends a call.
    await expect(page.getByTestId("source-select")).toBeVisible();
    await expect(page.getByRole("button", { name: /Fetch|Refresh/ })).toBeVisible();
  });

  test("names the programs seats.aero does not recognise", async ({ page }) => {
    await page.goto("/tools/coverage");
    // The catalogue's three groups, and the third is the point of the pane: a
    // name that looks like a source and answers 200 [] is a real category, not
    // a failure. Read off the OPEN menu rather than by selecting one of them —
    // selecting an unfetched source would fetch it.
    await page.getByTestId("source-select").click();
    await page.getByRole("listbox").waitFor();
    await expect(page.getByText("Names seats.aero does not know")).toBeVisible();
    await expect(page.getByRole("option", { name: "britishairways", exact: true })).toBeVisible();
    // Leave the menu without choosing anything.
    await page.keyboard.press("Escape");
  });

  test("asks for a pair before answering who flies it", async ({ page }) => {
    await page.goto("/tools/pair-lookup");
    await expect(page.getByText(/pick two airports/i)).toBeVisible();
  });
});
