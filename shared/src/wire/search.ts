import type { RoutePair } from "../routing.js";
import type { SourceTaskStatus, RunStatus } from "../ingest/types.js";
import type { SeatsAeroCall, SeatsAeroChunk } from "./seatsaero.js";

/**
 * One NDJSON frame from `POST /api/tracked-routes/:id/search`.
 *
 * All of this happens in the WORKER: the seats.aero Partner API is a keyed
 * vendor API that Cloudflare's IPs can reach, so searching a tracked route needs
 * nothing running on the user's machine. The unit of progress is a 90-day date
 * chunk, and each chunk is already applied to D1 by the time its `chunk_done`
 * frame lands.
 *
 * **A stream ending without a terminal frame is a FAILURE, never an empty
 * result** — and there are THREE terminal frames here, not two: `run_done`,
 * `error`, and `run_continue`.
 */
export type SearchEvent =
  | {
      type: "run_start";
      runId: string;
      origin: string;
      destination: string;
      chunks: SeatsAeroChunk[];
      /** Every city pair this search covers. One for a plain route, the cross
       *  product for a multi-airport one. */
      pairs: RoutePair[];
      /** Total tasks, so a resumed request can show real progress rather than
       *  restarting the count at zero. */
      total: number;
      /** Where THIS request starts in that list. */
      from: number;
    }
  | {
      type: "chunk_start";
      index: number;
      total: number;
      start: string;
      end: string;
      origins: string[];
      destinations: string[];
    }
  // One HTTP call to seats.aero, the moment it finishes. Carries the response
  // body (bounded by CAPTURE_BUDGET_BYTES) so the UI can show the exact payload
  // a find came from without a second round trip. The key is already redacted out
  // of `requestHeaders` in the provider — never add it back here.
  | ({ type: "call"; chunkIndex: number } & SeatsAeroCall)
  | {
      type: "chunk_done";
      index: number;
      start: string;
      end: string;
      status: SourceTaskStatus;
      offersFound: number;
      snapshotsWritten: number;
      snapshotsPruned: number;
      /** Outbound seats.aero calls this chunk spent. */
      calls: number;
      durationMs: number;
      /** Present when the chunk narrowed its own claim (paginated out). */
      note?: string;
      error?: string;
    }
  | { type: "quota"; remaining: number; limit?: number; observedAt: number }
  /**
   * This request stopped early to stay inside the Worker's subrequest budget,
   * and the run is NOT finished.
   *
   * A THIRD terminal frame beside `run_done` and `error`, and the client is
   * required to act on it: re-issue with `?runId=&from=` until one of the other
   * two arrives. The "a stream that ends without a terminal frame is a failure"
   * rule is unchanged — this is a terminal frame, it just means "continue"
   * rather than "finished". Everything applied so far is already durable, so a
   * client that stops here loses nothing but the remaining chunks.
   */
  | { type: "run_continue"; runId: string; nextIndex: number; total: number; calls: number }
  | {
      type: "run_done";
      runId: string;
      /** Every terminal status except `running` — a finished run is by
       *  definition not one. */
      status: Exclude<RunStatus, "running">;
      chunksOk: number;
      chunksFailed: number;
      offersFound: number;
      snapshotsWritten: number;
      snapshotsPruned: number;
      calls: number;
      durationMs: number;
    }
  | { type: "error"; message: string };
