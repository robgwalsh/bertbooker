export * from "./types.js";
export * from "./diff.js";
export * from "./collapse.js";
export * from "./routing.js";
export * from "./providers/index.js";
export * from "./sources/index.js";
// The PURE half of alerting — pacing and change selection. DOM-safe, like
// everything else here; the D1/fetch half lives in workers/api/src/alerts/.
export * from "./alerts/index.js";
export * from "./data/index.js";
// Only the WIRE contract, not `applyTask`. `ingest/apply.ts` references
// `D1Database` at module scope, so exporting it here would drag Cloudflare's
// ambient types into every consumer — including `packages/local-sources`, which
// runs on plain Node precisely because it is not on Cloudflare. The worker
// imports `@bertbooker/core/ingest` for the D1 half.
export * from "./ingest/types.js";
