// The pure half of alerting: what to sweep, how often, and which of a sweep's
// changes are worth an email. No D1, no fetch — the root export must stay
// DOM-safe (see shared/src/index.ts), and everything here is where the
// repo's testable logic is meant to live given there is no Worker test harness.
//
// The impure half is api/src/alerts/. docs/ALERTS.md is the argument.
export * from "./pace.js";
export * from "./select.js";
export * from "./digest.js";
