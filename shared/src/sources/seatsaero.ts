import {
  SEATSAERO_PROGRAMS,
  SEATSAERO_SOURCE_ID,
  SEATSAERO_HORIZON_DAYS,
} from "../providers/seatsaero.js";
import type { SourceDescriptor } from "./types.js";

/**
 * seats.aero — the only source, and a catalogue entry rather than a
 * `RunnableSource`.
 *
 * It is allowed on the Worker because it is a keyed vendor API that
 * authenticates the CREDENTIAL rather than judging the client: Cloudflare's IPs
 * reach it fine and a search needs no laptop awake. That is the test any future
 * source has to pass — see docs/SOURCES.md.
 *
 * How it must be DRIVEN is the reason it has no `run()`. The Worker's runner
 * (`api/src/searchRun.ts`) streams every HTTP call to the browser the moment it
 * lands, meters a per-request subrequest budget, and hands back a
 * `run_continue` frame so the client can resume a wide search across several
 * requests. None of that fits a plain `run(task)`: expressing it would mean
 * putting streaming callbacks, a byte budget and page accounting into the
 * interface every future source has to implement.
 *
 * So the split in `sources/types.ts` is by **who drives the source**, and this
 * is the descriptor half — identity, programs and horizon, which is what the
 * catalogue is actually for. The executable half lives beside the runner that
 * needs it: `planSeatsAeroChunks` and `runSeatsAeroChunk`.
 */
export const seatsAeroSource: SourceDescriptor = {
  id: SEATSAERO_SOURCE_ID,
  label: "seats.aero",
  programs: SEATSAERO_PROGRAMS,
  horizonDays: SEATSAERO_HORIZON_DAYS,
};
