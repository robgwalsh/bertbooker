// ---------------------------------------------------------------------------
// THE WIRE CONTRACT — one definition, read by the Worker and by the SPA.
// ---------------------------------------------------------------------------
//
// This directory exists because the two halves of every API response used to be
// written down twice. `app/src/api.ts` hand-mirrored ~25 types out of `api/src`
// and `shared/`, and its own banner recorded what that cost: a constant drifted
// after a migration renamed it, and every quota lookup silently matched nothing
// for months. Nothing checked either copy against the other, and for
// `AlertSchedule` there was no other copy — the SPA's interface was the only
// written-down form of a response the Worker built by hand.
//
// **The SPA imports THIS directory and nothing else in `shared/`.** Three
// modules are specifically out of bounds, and the reasons are not stylistic:
//
//   - `shared/src/index.ts` — the root barrel. It re-exports `ingest/index.js`
//     → `ingest/apply.ts`, which names `D1Database` at module scope. The app's
//     tsconfig has no `@cloudflare/workers-types`, so importing it fails
//     `tsc -p app` outright.
//   - `shared/src/ingest/index.ts` — same reason, one level down. Import
//     `ingest/types.js` by its deep path instead; that file is clean.
//   - `shared/src/sources/index.ts` — calls `registerSource(seatsAeroSource)` as
//     a TOP-LEVEL SIDE EFFECT. Importing it runs that (and it can throw), and it
//     defeats tree-shaking of the subtree.
//
// A fourth is out of bounds by size rather than by type:
// `providers/seatsaero.ts` is 1436 lines and speaks `fetch`. The constants and
// call records the SPA needs came OUT of it into `./seatsaero.ts`, and that file
// re-exports them so nothing in `api/` moved. Two modules that look pure —
// `routing.ts` and `alerts/pace.ts` — were importing a single integer from it
// and dragging the whole thing along; both now point here.
//
// `shared/tsconfig.wire.json` enforces all of this. It compiles this directory
// alone with neither DOM nor workers-types, so a wire file that reaches
// `D1Database` OR `fetch`/`Response` fails immediately, at the file that did it.
// `tsc -p app` catches only the first of those, and only at the far end.
//
// The root barrel deliberately does NOT re-export this directory. Keeping the
// two surfaces disjoint is what makes "the SPA imports only `shared/src/wire/*`"
// a rule you can grep for.

export * from "./domain.js";
export * from "./seatsaero.js";
export * from "./rows.js";
export * from "./reference.js";
export * from "./dashboard.js";
export * from "./search.js";
export * from "./enrich.js";
export * from "./alerts.js";
export * from "./quota.js";
export * from "./session.js";
export * from "./errors.js";
