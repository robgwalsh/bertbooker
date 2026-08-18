import { chromium } from "@playwright/test";
import { BASE_URL, STATE_PATH, ensureAuthState } from "./auth-state.js";
import { applyNetworkPolicy } from "./fixtures.js";

await ensureAuthState({});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  storageState: STATE_PATH,
  baseURL: BASE_URL,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await applyNetworkPolicy(page, { metered: [], foreignHosts: new Set() }, { online: false });
await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);

const result = await page.evaluate(() => {
  function rect(el: Element | null) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      minHeight: cs.minHeight,
    };
  }
  const overline = [...document.querySelectorAll("p,span,div")].find(
    (e) => e.textContent?.trim() === "Routes" && getComputedStyle(e).textTransform === "uppercase",
  );
  let node: Element | null = overline ?? null;
  let railHeaderEl: Element | null = null;
  while (node) {
    const cs = getComputedStyle(node);
    if (cs.display === "flex" && cs.flexDirection === "row" && cs.borderBottomWidth !== "0px") {
      railHeaderEl = node;
      break;
    }
    node = node.parentElement;
  }

  const searchBtn = [...document.querySelectorAll("button")].find((b) =>
    /search/i.test(b.textContent ?? ""),
  );
  let rowNode: Element | null = searchBtn ?? null;
  let stickyHeader: Element | null = null;
  while (rowNode) {
    const cs = getComputedStyle(rowNode);
    if (cs.position === "sticky") {
      stickyHeader = rowNode;
      break;
    }
    rowNode = rowNode.parentElement;
  }
  const innerStack = stickyHeader?.firstElementChild ?? null;

  return {
    railHeader: rect(railHeaderEl),
    routeHeaderSticky: rect(stickyHeader),
    routeHeaderInnerStack: rect(innerStack),
  };
});

console.log(JSON.stringify(result, null, 2));

await browser.close();
