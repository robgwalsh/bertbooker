import { registerSource } from "./registry.js";
import { pointsYeahSource } from "./pointsyeah.js";
import { seatsAeroSource } from "./seatsaero.js";

export * from "./types.js";
export * from "./registry.js";
export { pointsYeahSource, POINTSYEAH_PROGRAMS } from "./pointsyeah.js";
export { seatsAeroSource } from "./seatsaero.js";

/**
 * The built-in catalogue.
 *
 * Registration is a side effect of importing this module, and it happens once.
 * An embedder adding a third-party source calls `registerSource` itself after
 * importing here — the registry rejects a duplicate id rather than letting one
 * source silently shadow another, because two services writing rows under one
 * `availability_snapshots.source` would make a prune delete the wrong data.
 *
 * Note the two runtimes. `seatsaero` runs on the Worker; `pointsyeah` runs
 * locally. Neither runner can pick up the other's sources — see
 * `runnableSources`. docs/SOURCES.md.
 */
registerSource(seatsAeroSource);
registerSource(pointsYeahSource());
