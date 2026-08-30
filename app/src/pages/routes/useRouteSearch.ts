import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type SourceTaskStatus,
  type SearchCall,
  type SearchEvent,
} from "../../api";

/** One chunk of a search, as it unfolds. `pending` chunks are known from the
 *  `run_start` frame, so the panel shows the whole plan immediately rather than
 *  growing a row at a time — "three of five done" needs the five.
 *
 *  The two client-only states sit alongside the server's own task statuses
 *  rather than replacing them, so `blocked` still means exactly what it means in
 *  a failed task: we did not get an answer. */

/**
 * Which planned date range a TASK index belongs to.
 *
 * Chunk-major, matching `planSearchPass`: with two queries per range, tasks 0
 * and 1 are both the first range. Guards a zero or ragged group count by falling
 * back to the range at that index, so a frame from a Worker that plans
 * differently narrows the picture rather than crashing it.
 */
function plannedFor(
  chunks: readonly { start: string; end: string }[],
  total: number,
  index: number,
): { start: string; end: string } {
  const groups = chunks.length > 0 ? Math.max(1, Math.round(total / chunks.length)) : 1;
  return chunks[Math.min(Math.floor(index / groups), chunks.length - 1)] ?? chunks[0]!;
}

export interface ChunkState {
  start: string;
  end: string;
  status: "pending" | "running" | SourceTaskStatus;
  /** The airports this task asked about. Filled in when the task starts —
   *  `run_start` knows the count but not the order. */
  origins?: string[];
  destinations?: string[];
  offersFound?: number;
  snapshotsWritten?: number;
  snapshotsPruned?: number;
  calls?: number;
  durationMs?: number;
  note?: string;
  error?: string;
  /** Every HTTP call this chunk made, arriving one at a time as they finish.
   *  Populated before `chunk_done`, so a slow page is visible while it is still
   *  in flight rather than only in hindsight. */
  httpCalls: SearchCall[];
}

/** One route's search, as it unfolds. Session state only — a reload clears it,
 *  which is exactly right: this is a diagnostic for the run you just triggered.
 *  The *findings* are already in D1 and come back through `["routes"]`. */
export interface RunState {
  status: "running" | "done" | "error";
  startedAt: number;
  runId?: string;
  /** Every city pair the search covers — one for a plain route, the cross
   *  product for a multi-airport one. */
  pairs?: { origin: string; destination: string }[];
  chunks: ChunkState[];
  /** Outbound seats.aero calls spent so far. */
  calls: number;
  /** Latest reading of the daily allowance, if the vendor sent one. */
  remaining?: number;
  limit?: number;
  offersFound?: number;
  snapshotsWritten?: number;
  /** Terminal run status once `run_done` lands. `partial` matters: it means some
   *  of the window was never actually looked at. */
  runStatus?: "ok" | "partial" | "failed" | "aborted";
  /** The Worker stopped inside its subrequest budget and `searchRoute` is
   *  re-asking from `nextIndex`. Cleared by the next `chunk_start`. Surfacing
   *  this matters: against a still progress bar, a pause of several seconds
   *  reads as a hang. */
  paused?: boolean;
  error?: string;
}

export interface RouteSearch {
  runs: Record<number, RunState>;
  start: (id: number) => void;
  isRunning: (id: number) => boolean;
  /** Drop one route's panel. The panel is a diagnostic for a run that has
   *  finished and whose findings are already in D1, so discarding it loses
   *  nothing — it is the *stream* that must never be cut short, not the report
   *  of one. Refuses while the run is still going, for that reason. */
  dismiss: (id: number) => void;
}

const EMPTY: RunState = { status: "running", startedAt: 0, chunks: [], calls: 0 };

export function useRouteSearch(): RouteSearch {
  const qc = useQueryClient();
  const [runs, setRuns] = useState<Record<number, RunState>>({});
  // Guards a second start for a route already in flight (a stale render firing
  // onClick again). The button is disabled too, but this is the one that holds.
  const inFlight = useRef(new Set<number>());

  const start = useCallback(
    (id: number) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);

      const patch = (fn: (s: RunState) => RunState) =>
        setRuns((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY) }));

      setRuns((prev) => ({
        ...prev,
        [id]: { status: "running", startedAt: Date.now(), chunks: [], calls: 0 },
      }));

      void (async () => {
        // A stream that ends without a terminal frame died mid-flight. Treating
        // that as "done, nothing found" is the exact confusion this app is built
        // to avoid, so track it explicitly.
        let settled = false;
        try {
          for await (const e of api.searchRoute(id)) {
            switch (e.type as SearchEvent["type"]) {
              case "run_start": {
                const f = e as Extract<SearchEvent, { type: "run_start" }>;
                patch((s) => ({
                  ...s,
                  runId: f.runId,
                  pairs: f.pairs,
                  // Building the whole plan up front is what lets the panel say
                  // "3 of 5" instead of growing a row at a time, and is what
                  // lets the date bar be drawn to its full width immediately.
                  //
                  // Merged rather than rebuilt when the shape holds: a resumed
                  // request sends `run_start` again, and re-creating the array
                  // would throw away every finished chunk the user is looking at.
                  // The DATES are taken from the new plan either way — the plan
                  // is recomputed per request against a fresh `today`, so a run
                  // resuming across UTC midnight re-plans with every boundary
                  // shifted a day, and the bar would otherwise keep drawing the
                  // old ones.
                  // A task is one QUERY over one date range, and a route with
                  // hubs plans two queries per range — so `total` is
                  // `chunks × groups` and the mapping is CHUNK-MAJOR: tasks
                  // 0..groups-1 all belong to chunk 0. `plannedFor` is that
                  // arithmetic; it was `i % chunks.length`, which happened to be
                  // the identity while the two counts were equal and is the
                  // wrong range the moment they are not.
                  chunks:
                    s.chunks.length === f.total
                      ? s.chunks.map((c, i) => {
                          const planned = plannedFor(f.chunks, f.total, i);
                          return c.start === planned.start && c.end === planned.end
                            ? c
                            : { ...c, start: planned.start, end: planned.end };
                        })
                      : Array.from({ length: f.total }, (_, i) => ({
                          start: plannedFor(f.chunks, f.total, i).start,
                          end: plannedFor(f.chunks, f.total, i).end,
                          status: "pending" as const,
                          httpCalls: [],
                        })),
                }));
                break;
              }
              case "call": {
                const f = e as Extract<SearchEvent, { type: "call" }>;
                const { type: _t, chunkIndex, ...call } = f;
                patch((s) => ({
                  ...s,
                  chunks: s.chunks.map((c, i) =>
                    i === chunkIndex ? { ...c, httpCalls: [...c.httpCalls, call] } : c,
                  ),
                }));
                break;
              }
              case "chunk_start": {
                const f = e as Extract<SearchEvent, { type: "chunk_start" }>;
                patch((s) => ({
                  ...s,
                  paused: false,
                  chunks: s.chunks.map((c, i) =>
                    i === f.index
                      ? {
                          ...c,
                          status: "running",
                          origins: f.origins,
                          destinations: f.destinations,
                        }
                      : c,
                  ),
                }));
                break;
              }
              case "chunk_done": {
                const f = e as Extract<SearchEvent, { type: "chunk_done" }>;
                patch((s) => ({
                  ...s,
                  calls: s.calls + f.calls,
                  chunks: s.chunks.map((c, i) =>
                    i === f.index
                      ? {
                          ...c,
                          status: f.status,
                          offersFound: f.offersFound,
                          snapshotsWritten: f.snapshotsWritten,
                          snapshotsPruned: f.snapshotsPruned,
                          calls: f.calls,
                          durationMs: f.durationMs,
                          note: f.note,
                          error: f.error,
                        }
                      : c,
                  ),
                }));
                break;
              }
              case "quota": {
                const f = e as Extract<SearchEvent, { type: "quota" }>;
                patch((s) => ({ ...s, remaining: f.remaining, limit: f.limit }));
                break;
              }
              case "run_continue": {
                // Not a terminal state for the UI: `searchRoute` re-issues from
                // `nextIndex` under the same run id and keeps yielding into this
                // same loop. All this does is give the panel something to say
                // during the gap between requests.
                patch((s) => ({ ...s, paused: true }));
                break;
              }
              case "run_done": {
                const f = e as Extract<SearchEvent, { type: "run_done" }>;
                settled = true;
                // Totals come from the chunks, not from the frame: a resumed
                // search sends `run_done` from its LAST request only, whose
                // figures cover that request alone. The chunk states span the
                // whole run.
                patch((s) => ({
                  ...s,
                  status: "done",
                  paused: false,
                  runStatus: f.status,
                  offersFound: s.chunks.reduce((n, c) => n + (c.offersFound ?? 0), 0),
                  snapshotsWritten: s.chunks.reduce((n, c) => n + (c.snapshotsWritten ?? 0), 0),
                }));
                break;
              }
              case "error": {
                const f = e as Extract<SearchEvent, { type: "error" }>;
                settled = true;
                patch((s) => ({ ...s, status: "error", paused: false, error: f.message }));
                break;
              }
            }
          }
          if (!settled) {
            patch((s) => ({
              ...s,
              status: "error",
              error: "the search stream ended without finishing — results may be incomplete",
            }));
          }
        } catch (err) {
          patch((s) => ({ ...s, status: "error", error: String(err) }));
        } finally {
          inFlight.current.delete(id);
          // The finds themselves were written chunk by chunk while this ran; this
          // is the refresh that shows them, plus the quota card's number.
          void qc.invalidateQueries({ queryKey: ["routes"] });
          void qc.invalidateQueries({ queryKey: ["quota"] });
        }
      })();
    },
    [qc],
  );

  const isRunning = useCallback((id: number) => runs[id]?.status === "running", [runs]);

  const dismiss = useCallback((id: number) => {
    // Guarded on `inFlight`, not on the rendered status: the generator holds
    // `id` and keeps patching, so clearing a live run would leave a half-built
    // panel reappearing on the next frame.
    if (inFlight.current.has(id)) return;
    setRuns((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  return { runs, start, isRunning, dismiss };
}
