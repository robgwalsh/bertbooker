export * from "./types.js";
export * from "./diff.js";
export * from "./collapse.js";
export * from "./routing.js";
export * from "./providers/index.js";
export * from "./sources/index.js";
// The PURE half of alerting — pacing and change selection. DOM-safe, like
// everything else here; the D1/fetch half lives in api/src/alerts/.
export * from "./alerts/index.js";
export * from "./data/index.js";
// The whole of ingest, task report and `applyTask` alike.
//
// These were split for years: `ingest/apply.ts` references `D1Database` at
// module scope, and exporting it from here would have dragged Cloudflare's
// ambient types into a plain-Node consumer that ran the local sources. That
// consumer is gone. The Worker is the only thing that imports THIS FILE, it
// already has `@cloudflare/workers-types`, and one barrel beats a subpath map
// on a directory that is no longer a package.
//
// **A narrower entry point exists again, and this is what it is narrower than.**
// `src/wire/` is the SPA's, and this barrel is precisely what the SPA must not
// import — the line below is the reason, transitively. Anything the browser
// needs from `ingest/` comes from `ingest/types.js` by its deep path. See the
// banner in `src/wire/index.ts`; `../tsconfig.wire.json` enforces it.
export * from "./ingest/index.js";
