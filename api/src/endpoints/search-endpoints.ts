import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Env, Vars } from "../bindings.js";
import { rowIdParam } from "../util/params.js";
import {
  openSearchRun,
  planSearchPass,
  runSearchPass,
  type PlanFailure,
  type SearchEvent,
} from "../features/search/run.js";

/**
 * Searching a tracked route, on the Worker, against seats.aero.
 */
export const search = new Hono<{ Bindings: Env; Variables: Vars }>();

export type { SearchEvent } from "../features/search/run.js";

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
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);
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
