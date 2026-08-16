import {
  SEATSAERO_PROGRAMS,
  SEATSAERO_SOURCE_ID,
  SEATSAERO_HORIZON_DAYS,
} from "../providers/seatsaero.js";
import type { SourceDescriptor } from "./types.js";

/**
 * seats.aero — a catalogue entry, not a `RunnableSource`, and the reason is
 * worth stating because it is the one place the plug-in system bends.
 *
 * seats.aero runs on the **Worker** (`runtime: "worker"`): it is a keyed vendor
 * API that authenticates the credential rather than judging the client, so
 * Cloudflare's IPs reach it fine and a search needs no laptop awake. That much
 * is ordinary.
 *
 * What is not ordinary is how it must be driven. The Worker's runner
 * (`workers/api/src/searchRun.ts`) streams every HTTP call to the browser the
 * moment it lands, meters a per-request subrequest budget, and hands back a
 * `run_continue` frame so the client can resume a wide search across several
 * requests. None of that fits a plain `run(task)`: expressing it would mean
 * putting streaming callbacks, a byte budget and page accounting into the
 * interface every future source has to implement.
 *
 * So the split in `sources/types.ts` is by **who drives the source**, and this
 * is the descriptor half — identity, programs, horizon and placement, which is
 * what the catalogue is actually for. The executable half lives beside the
 * runner that needs it: `planSeatsAeroChunks` and `runSeatsAeroChunk`.
 */
export const seatsAeroSource: SourceDescriptor = {
  id: SEATSAERO_SOURCE_ID,
  label: "seats.aero",
  programs: SEATSAERO_PROGRAMS,
  horizonDays: SEATSAERO_HORIZON_DAYS,
  runtime: "worker",
};
