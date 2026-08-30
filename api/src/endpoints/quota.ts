import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import type { QuotaPage } from "../../../shared/src/wire/index.js";
import { selectQuotaSince } from "../db/sourceQuota.js";

/**
 * What's left of each metered source's daily API allowance.
 *
 * It is not an ingest endpoint: it reads `source_quota` and nothing else, and
 * it feeds the app-bar quota chip on Routes and Alerts and in the itinerary
 * drawer.
 *
 * A read, so no ingest token — the `identity` middleware on `/api/*` already
 * covers it. Returns the last week so the card can say "no calls today" against
 * something rather than against silence, and so a day that ran dry stays visible
 * the morning after.
 */
export const quota = new Hono<{ Bindings: Env; Variables: Vars }>();

quota.get("/api/quota", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const results = await selectQuotaSince(c.env.DB, since);
  // `today` travels with the payload so the SPA doesn't have to agree with the
  // server about what UTC day it is before it can pick out today's row.
  const body: QuotaPage = { today: new Date().toISOString().slice(0, 10), quota: results };
  return c.json(body);
});
