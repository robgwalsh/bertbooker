import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { D1Usage, D1UsagePage } from "../models/wire/index.js";
import { fetchD1RowTotals, utcDay } from "../providers/cloudflareAnalytics.js";

export const d1Usage = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_READ_LIMIT = 5_000_000;
const DEFAULT_WRITTEN_LIMIT = 100_000;

function limitFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

d1Usage.get("/api/d1-usage", async (c) => {
  const now = Date.now();
  const totals = await fetchD1RowTotals(c.env, now);
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
