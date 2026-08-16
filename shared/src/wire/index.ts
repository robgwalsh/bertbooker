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
// **The SPA imports THIS directory, and `shared/src/` holds nothing else.**
// That used to be a rule with a list of exceptions attached — three modules the
// app was forbidden to touch (the root barrel and `ingest/`'s, both of which
// reached `ingest/apply.ts` and its module-scope `D1Database`; and
// `sources/index.ts`, which calls `registerSource()` as a top-level side
// effect), plus `providers/seatsaero.ts`, out of bounds by sheer size. All four
// now live in `api/src/`, so the rule needs no exception list: there is nothing
// else in `shared/` to forbid.
//
// **Every declaration the SPA reads is DECLARED here, not borrowed.** The
// modules in this directory import only each other. That is the property that
// let the Worker-only half of `shared/` move out — previously seven backend
// files (`types.ts`, `diff.ts`, `routing.ts`, `ingest/types.ts`,
// `data/programs.ts`, `data/airlines.ts`, `alerts/pace.ts`) were pinned in place
// purely because `./domain.ts` quoted a type name out of each. The direction is
// now the one `./seatsaero.ts` established: the declaration lives here and the
// backend module re-exports it, so no `api/` import had to move.
//
// `shared/tsconfig.wire.json` enforces this. It compiles this directory alone
// with neither DOM nor workers-types, so a wire file that reaches `D1Database`
// OR `fetch`/`Response` fails immediately, at the file that did it. `tsc -p app`
// catches only the first of those, and only at the far end. `shared/tsconfig.json`
// then checks the same files a second time WITH both, as part of the whole
// directory: that pass proves they compose with the Worker's code, this one
// proves they need none of it.

export * from "./domain.js";
export * from "./routing.js";
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
