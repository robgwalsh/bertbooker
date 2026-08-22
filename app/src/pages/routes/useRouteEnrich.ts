import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type EnrichEvent } from "../../api";

/**
 * "Enrich all" for one tracked route, as it unfolds.
 *
 * Deliberately the same shape as `useRouteSearch`, because it holds the same
 * three promises and they are easy to lose one at a time:
 *
 *  - a stream that ends without a terminal frame is a **failure**, never an
 *    empty result;
 *  - a second start for a route already in flight is refused by a ref, not only
 *    by a disabled button;
 *  - the findings were written row by row while it ran, so the invalidations at
 *    the end are a refresh, not the delivery.
 *
 * Simpler in one way: enrichment plans no chunks, so there is nothing to show
 * before the first item lands — just a count against the total.
 */
export interface EnrichState {
  status: "running" | "done" | "error";
  startedAt: number;
  /** Availability rows this run will expand — one seats.aero call each. */
  targets: number;
  /** Items finished, whatever the outcome. The progress numerator. */
  done: number;
  /** Cabins that gained a real itinerary. */
  enriched: number;
  failed: number;
  /** Rows seats.aero had no matching itinerary for. Not an error: the summary
   *  stands, and the row records that it was asked. */
  empty: number;
  /** True when the per-run cap bit. `left` is what a second run would pick up —
   *  reported rather than swallowed, so "done" never overstates itself. */
  capped: boolean;
  left: number;
  remainingQuota?: number;
  error?: string;
}

export interface RouteEnrich {
  runs: Record<number, EnrichState>;
  start: (id: number) => void;
  isRunning: (id: number) => boolean;
  /** Drop one route's panel once it has finished. Same contract, and same
   *  reasoning, as `useRouteSearch`'s. */
  dismiss: (id: number) => void;
}

const EMPTY: EnrichState = {
  status: "running",
  startedAt: 0,
  targets: 0,
  done: 0,
  enriched: 0,
  failed: 0,
  empty: 0,
  capped: false,
  left: 0,
};

export function useRouteEnrich(): RouteEnrich {
  const qc = useQueryClient();
  const [runs, setRuns] = useState<Record<number, EnrichState>>({});
  const inFlight = useRef(new Set<number>());

  const start = useCallback(
    (id: number) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);

      const patch = (fn: (s: EnrichState) => EnrichState) =>
        setRuns((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY) }));

      setRuns((prev) => ({ ...prev, [id]: { ...EMPTY, startedAt: Date.now() } }));

      void (async () => {
        let settled = false;
        try {
          for await (const e of api.enrichRoute(id)) {
            switch (e.type as EnrichEvent["type"]) {
              case "run_start": {
                const f = e as Extract<EnrichEvent, { type: "run_start" }>;
                patch((s) => ({
                  ...s,
                  targets: f.targets,
                  capped: f.capped,
                  left: f.totalTargets - f.targets,
                }));
                break;
              }
              case "item": {
                const f = e as Extract<EnrichEvent, { type: "item" }>;
                patch((s) => ({
                  ...s,
                  done: s.done + 1,
                  enriched: s.enriched + f.cabins.length,
                  // Anything that isn't ok/empty is a real refusal, and the
                  // status word carries why — 'blocked' at 401 is a wrong key,
                  // at 429 a spent day.
                  failed: s.failed + (f.status === "ok" || f.status === "empty" ? 0 : 1),
                  empty: s.empty + (f.status === "empty" ? 1 : 0),
                }));
                break;
              }
              case "quota": {
                const f = e as Extract<EnrichEvent, { type: "quota" }>;
                patch((s) => ({ ...s, remainingQuota: f.remaining }));
                break;
              }
              case "run_done": {
                const f = e as Extract<EnrichEvent, { type: "run_done" }>;
                settled = true;
                patch((s) => ({
                  ...s,
                  status: "done",
                  enriched: f.enriched,
                  failed: f.failed,
                  empty: f.empty,
                  capped: f.capped,
                  left: f.remaining,
                }));
                break;
              }
              case "error": {
                const f = e as Extract<EnrichEvent, { type: "error" }>;
                settled = true;
                patch((s) => ({ ...s, status: "error", error: f.message }));
                break;
              }
            }
          }
          if (!settled) {
            patch((s) => ({
              ...s,
              status: "error",
              error:
                "the enrich stream ended without finishing — some rows may not have been fetched",
            }));
          }
        } catch (err) {
          patch((s) => ({ ...s, status: "error", error: String(err) }));
        } finally {
          inFlight.current.delete(id);
          void qc.invalidateQueries({ queryKey: ["routes"] });
          void qc.invalidateQueries({ queryKey: ["finds"] });
          void qc.invalidateQueries({ queryKey: ["quota"] });
        }
      })();
    },
    [qc],
  );

  const isRunning = useCallback((id: number) => runs[id]?.status === "running", [runs]);

  const dismiss = useCallback((id: number) => {
    if (inFlight.current.has(id)) return;
    setRuns((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  return { runs, start, isRunning, dismiss };
}
