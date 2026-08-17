import { registerSource } from "./registry.js";
import { seatsAeroSource } from "./seatsaero.js";

export * from "./types.js";
export * from "./registry.js";
export { seatsAeroSource } from "./seatsaero.js";

/**
 * The built-in catalogue — one entry.
 *
 * Registration is a side effect of importing this module, and it happens once,
 * on Worker boot. That is not ceremony: `registerSource` validates every
 * program the source declares against `PROGRAM_SEEDS`, and
 * `availability_snapshots.program` is a foreign key — so a typo that would
 * otherwise surface as a write failing mid-search fails at import instead.
 *
 * **`api/src/index.ts` imports this file for the side effect and nothing else.**
 * That import is the entire mechanism, and it looks removable to anyone tidying
 * unused imports — it is not. No file imports a symbol from this directory.
 *
 * A second source would call `registerSource` itself after importing here. The
 * registry rejects a duplicate id rather than letting one source silently shadow
 * another, because two services writing rows under one
 * `availability_snapshots.source` would make a prune delete the wrong data.
 * docs/SOURCES.md.
 */
registerSource(seatsAeroSource);
