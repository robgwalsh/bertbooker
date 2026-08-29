import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { D1Usage, D1UsagePage } from "../../../shared/src/wire/index.js";
import { fetchD1RowTotals, utcDay } from "../providers/cloudflareAnalytics.js";

/**
 * What today's D1 row allowance stands at, for the two right-hand app-bar chips.
 *
 * SEPARATE FROM `/api/quota` on purpose, though the chips sit side by side.
 * That endpoint is a pure D1 read; this one waits on Cloudflare. Five surfaces
 * depend on `/api/quota` and three of them invalidate it after every spend, so
 * folding an outbound fetch into it would put a five-second timeout in front of
 * the seats.aero number every time someone enriches a row. Two endpoints, two
 * query keys, and a slow answer from Cloudflare costs only the chips it is
 * about.
 *
 * A read that spends no metered call, so it is deliberately NOT in
 * `METERED_PATTERNS` (`e2e/fixtures.ts`) — UI tests may reach it freely.
 *
 * The `identity` middleware on `/api/*` already covers it; there is no auth
 * here.
 */
export const d1Usage = new Hono<{ Bindings: Env; Variables: Vars }>();

/** The Workers FREE per-day allowances, which is what this app runs on. Read
 *  `D1_ROWS_READ_LIMIT` / `D1_ROWS_WRITTEN_LIMIT` in `bindings.ts` before
 *  changing either — the paid plan's equivalents are monthly, not daily. */
const DEFAULT_READ_LIMIT = 5_000_000;
const DEFAULT_WRITTEN_LIMIT = 100_000;

function limitFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

d1Usage.get("/api/d1-usage", async (c) => {
  const now = Date.now();
  const totals = await fetchD1RowTotals(c.env, now);
  // `usage` is omitted rather than zeroed when Cloudflare could not be asked.
  // See the note on `D1UsagePage` — this is the whole reason the field is
  // optional, and a `{ rowsRead: 0 }` here would render as a full allowance.
  const usage: D1Usage | undefined = totals && {
    day: utcDay(now),
    observedAt: now,
    rowsRead: totals.rowsRead,
    rowsWritten: totals.rowsWritten,
    readLimit: limitFrom(c.env.D1_ROWS_READ_LIMIT, DEFAULT_READ_LIMIT),
    writtenLimit: limitFrom(c.env.D1_ROWS_WRITTEN_LIMIT, DEFAULT_WRITTEN_LIMIT),
  };
  const body: D1UsagePage = usage ? { usage } : {};
  return c.json(body);
});
