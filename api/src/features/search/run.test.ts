import { describe, expect, it } from "vitest";
import { planSearchPass, runStatus } from "./run.js";

/** A D1 that answers `selectSearchRoute` with one row and nothing else. */
function dbWith(route: Record<string, unknown>) {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => route }),
    }),
  } as unknown as D1Database;
}

const route = (over: Record<string, unknown> = {}) => ({
  id: 25,
  origin: "SFO",
  destination: "KTM",
  origins: '["SFO"]',
  destinations: '["KTM"]',
  date_start: "2026-10-01",
  date_end: "2026-12-20",
  round_trip: 0,
  via: null,
  ...over,
});

describe("planSearchPass — the hub legs' dates", () => {
  it("asks the LAST inbound query one day past the window, as the matcher shows", async () => {
    // An overnight in the hub on the last date is a real journey, and the
    // second leg then departs the day after the window closes. `routeMatcher`
    // and the SPA both accept that date; without this nothing ever gathered it.
    const planned = await planSearchPass(dbWith(route({ via: '["ICN"]' })), {
      email: "a@example.com",
      routeId: 25,
      apiKey: "k",
      today: "2026-09-09",
    });
    if (!planned.ok) throw new Error(planned.failure.code);
    const { tasks, chunks } = planned.plan;
    const inbound = tasks.filter((t) => t.group.role === "inbound");
    const outbound = tasks.filter((t) => t.group.role === "outbound");
    expect(inbound.at(-1)!.chunk.end).toBe("2026-12-21");
    expect(outbound.at(-1)!.chunk.end).toBe("2026-12-20");
    // Only the last chunk widens; the others still tile the window exactly.
    expect(inbound.slice(0, -1).map((t) => t.chunk)).toEqual(chunks.slice(0, -1));
  });

  it("leaves a route without hubs alone", async () => {
    const planned = await planSearchPass(dbWith(route()), {
      email: "a@example.com",
      routeId: 25,
      apiKey: "k",
      today: "2026-09-09",
    });
    if (!planned.ok) throw new Error(planned.failure.code);
    expect(planned.plan.tasks.map((t) => t.chunk)).toEqual(planned.plan.chunks);
  });
});

describe("runStatus", () => {
  it("reads a run with a truncated task as partial, never as clean", () => {
    // A task that could not read everything the source held looks, from the
    // outside, exactly like "there is no award space" on the dates it missed.
    expect(runStatus(4, 0, 4, 1)).toBe("partial");
    expect(runStatus(4, 0, 4)).toBe("ok");
  });
});
