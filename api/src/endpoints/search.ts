import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Env, Vars } from "../bindings.js";
import {
  openSearchRun,
  planSearchPass,
  runSearchPass,
  type PlanFailure,
  type SearchEvent,
} from "../search/run.js";

/**
 * Searching a tracked route, on the Worker, against seats.aero.
 *
 * The engine moved to `search/run.ts` when the alert scheduler became its second
 * caller — two implementations of "search a route and ingest the result" would
 * eventually disagree about coverage, which is the one thing in this pipeline
 * that silently destroys data. What is left here is the HTTP shape: a preflight
 * that fails with real status codes, and a stream.
 *
 * What HAS changed since this file said otherwise: something does now run on a
 * schedule. A Cron Trigger sweeps alert-enabled routes through the same engine
 * (`alerts/sweep.ts`), and it — alone — consults the day's remaining quota
 * before spending. This endpoint does not, and must not: nobody needs protecting
 * from a call they deliberately asked for. See `docs/ALERTS.md`.
 *
 * **Everything fallible happens before the stream opens.** Once the first byte is
 * written the response is committed to 200 and an `error` frame is all that is
 * left — so a missing `SEATS_AERO_API_KEY` is a 503, never an empty result that
 * would read as "no award space". That is why `planSearchPass` and
 * `openSearchRun` are separate from `runSearchPass`.
 */
export const search = new Hono<{ Bindings: Env; Variables: Vars }>();

export type { SearchEvent } from "../search/run.js";

/** The engine's refusal codes as HTTP. The engine returns a code rather than a
 *  status because its other caller — the cron sweep — has no response to put one
 *  on and reports the same refusals as named skip reasons instead. */
function failureResponse(failure: PlanFailure): { body: Record<string, unknown>; status: 400 | 404 | 503 } {
  switch (failure.code) {
    case "not_found":
      return { body: { error: "not_found" }, status: 404 };
    case "run_not_found":
      return { body: { error: "run_not_found" }, status: 404 };
    case "no_seats_aero_key":
      // 503, never an empty result. "We have no key" and "there is no award
      // space" are the same absence and opposite facts.
      return { body: { error: "no_seats_aero_key" }, status: 503 };
    case "window_outside_horizon":
      return { body: { error: "window_outside_horizon", today: failure.today }, status: 400 };
    case "bad_route_spec":
      return { body: { error: "bad_route_spec", message: failure.message }, status: 400 };
    case "nothing_to_resume":
      return { body: { error: "nothing_to_resume", total: failure.total }, status: 400 };
  }
}

search.post("/api/tracked-routes/:id/search", async (c) => {
  const email = c.get("userEmail");
  const id = Number(c.req.param("id"));
  const startedAt = Date.now();

  const planned = await planSearchPass(c.env.DB, {
    email,
    routeId: id,
    apiKey: c.env.SEATS_AERO_API_KEY,
    from: Number(c.req.query("from") ?? 0),
  });
  if (!planned.ok) {
    const { body, status } = failureResponse(planned.failure);
    return c.json(body, status);
  }

  const opened = await openSearchRun(c.env.DB, planned.plan, {
    trigger: "search",
    resumeRunId: c.req.query("runId"),
    startedAt,
  });
  if (!opened.ok) {
    const { body, status } = failureResponse(opened.failure);
    return c.json(body, status);
  }

  c.header("content-type", "application/x-ndjson");
  c.header("cache-control", "no-store");
  // A buffering proxy defeats the point of streaming; the dev proxy sets this
  // too. See web/vite.config.ts.
  c.header("x-accel-buffering", "no");

  return stream(c, async (s) => {
    await runSearchPass(c.env.DB, planned.plan, opened.runId, {
      signal: c.req.raw.signal,
      startedAt,
      onEvent: async (e: SearchEvent) => {
        await s.write(`${JSON.stringify(e)}\n`);
      },
    });
  });
});
