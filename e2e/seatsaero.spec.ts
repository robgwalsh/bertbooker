import { test, expect } from "./fixtures.js";

/**
 * The Library's seats.aero pane.
 *
 * Everything asserted here has to hold against an EMPTY database — no tracked
 * routes, no fetched sources — so nothing below looks for a route row or a
 * graph. What it does check is the distinction the pane exists for: an
 * unfetched source must read as "not fetched", never as "flies nowhere".
 *
 * **Nothing here may select a source in the dropdown.** Picking a program that
 * has never been fetched now fetches it, which is a real seats.aero call;
 * `fixtures.ts` fails any test that reaches `/api/seatsaero/sources/:source/
 * fetch`, and it is in `METERED_PATTERNS` for exactly this spec. Opening the tab
 * is free by design — the auto-fetch fires on an explicit selection, never on
 * mount — and that is the property these tests are allowed to lean on.
 */
test.describe("Library → seats.aero", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/library");
    await page.getByRole("tab", { name: "seats.aero" }).click();
  });

  test("renders the pane and its three sections", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Data Coverage" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Who flies this pair?" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your tracked routes" })).toBeVisible();
  });

  test("offers a refresh control without spending anything to show it", async ({ page }) => {
    // Present on arrival, and merely arriving costs nothing — see the note
    // above. Not pressed: it is the one control in the pane that spends a call.
    await expect(page.getByTestId("source-select")).toBeVisible();
    await expect(page.getByRole("button", { name: /Fetch|Refresh/ })).toBeVisible();
  });

  test("names the programs seats.aero does not recognise", async ({ page }) => {
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
    await expect(page.getByText(/pick two airports/i)).toBeVisible();
  });
});
