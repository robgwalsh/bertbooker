import { notifyLocked } from "../lib/auth";
import { readNdjson, searchErrorMessage, SEARCH_TIMEOUT_MS } from "./client";
import type { ApiErrorBody, SearchEvent } from "../../../api/src/models/wire/index.js";

/**
 * Search one tracked route against seats.aero, yielding each frame as it arrives.
 *
 * Deliberately not TanStack Query: this is a stream whose *partial* state is the
 * point (chunk rows filling in one at a time), not a request/response a cache can
 * hold. Every chunk's finds are already in D1 by the time you see its frame, so
 * invalidating `["routes"]` at the end is a refresh, not the delivery.
 *
 * Failures before the first byte arrive as a status code, because the Worker does
 * everything fallible before opening the stream — a missing API key is a 503 here
 * and must surface as an error, never as "no award space found".
 *
 * **A wide route takes several HTTP requests, and this generator hides that.**
 * The Worker stops after a bounded number of outbound calls so it stays inside
 * its subrequest budget, and says so with a `run_continue` frame; this resumes
 * from `nextIndex` under the same run id until `run_done` or `error`. Consumers
 * see one continuous stream and one terminal frame, which is what keeps the
 * "a stream that ends without a terminal frame is a failure" rule simple for
 * every caller. `run_continue` is still yielded, so a UI can show the pause.
 */
export async function* searchRoute(
  id: number,
  signal?: AbortSignal,
): AsyncGenerator<SearchEvent> {
  let runId: string | undefined;
  let from = 0;

  // Bounded so a Worker that somehow always pauses cannot spin forever. One
  // request per group-chunk is the worst legitimate case.
  for (let request = 0; request < 64; request++) {
    const query = runId ? `?runId=${encodeURIComponent(runId)}&from=${from}` : "";
    const path = `/tracked-routes/${id}/search${query}`;
    const res = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as ApiErrorBody | null;
      // This stream doesn't go through `req`, so the lockout hand-off is repeated
      // here — a search started on a session that lapsed mid-afternoon has to
      // raise the dialog, not just report a failed search.
      if (res.status === 401 && detail?.error === "locked") notifyLocked();
      throw new Error(searchErrorMessage(detail?.error) ?? `POST ${path} -> ${res.status}`);
    }

    let paused = false;
    for await (const event of readNdjson<SearchEvent>(res)) {
      if (event.type === "run_continue") {
        runId = event.runId;
        from = event.nextIndex;
        paused = true;
      }
      yield event;
    }
    if (!paused) return;
    if (signal?.aborted) return;
  }
}
