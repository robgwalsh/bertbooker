import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_TYPES, dropPercent, parseAlertTypes, selectAlertable } from "./select.js";
import type { ChangeSummary, ChangeType } from "../../domain/diff.js";

/**
 * Which of a sweep's changes are worth an email.
 *
 * Pure. The interesting cases are the two asymmetries: an empty `alert_on` is
 * refused at the API rather than stored (it would mean "armed and silent
 * forever"), and `gone` bypasses the find intersection because there is no
 * current row for a disappearance to intersect with.
 */

describe("parseAlertTypes", () => {
  it("treats NULL as the default set", () => {
    expect(parseAlertTypes(null)).toEqual(DEFAULT_ALERT_TYPES);
  });

  it("leaves `gone` out of the default set", () => {
    expect(DEFAULT_ALERT_TYPES).not.toContain("gone");
  });

  it("keeps a stored selection", () => {
    expect(parseAlertTypes('["gone","price_drop"]')).toEqual(["gone", "price_drop"]);
  });

  it("falls back rather than going silent on a corrupted value", () => {
    // An empty set is refused at the API, so reading one back means damage —
    // and "alerts on, nothing fires" is the failure mode that looks like success.
    expect(parseAlertTypes("[]")).toEqual(DEFAULT_ALERT_TYPES);
    expect(parseAlertTypes('["nonsense"]')).toEqual(DEFAULT_ALERT_TYPES);
    expect(parseAlertTypes("not json")).toEqual(DEFAULT_ALERT_TYPES);
  });
});

const change = (over: Partial<ChangeSummary> & { type: ChangeType; key: string }): ChangeSummary => ({
  flightDate: "2026-11-14",
  program: "alaska",
  cabin: "business",
  origin: "SEA",
  destination: "NRT",
  ...over,
});

describe("dropPercent", () => {
  it("measures the fall against what it was", () => {
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 80, previousMilesCost: 100 }))).toBe(20);
  });

  it("is zero when there is nothing to compare, or the price rose", () => {
    expect(dropPercent(change({ type: "new", key: "k", milesCost: 80 }))).toBe(0);
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 120, previousMilesCost: 100 }))).toBe(0);
    expect(dropPercent(change({ type: "price_drop", key: "k", milesCost: 80, previousMilesCost: 0 }))).toBe(0);
  });
});

describe("selectAlertable", () => {
  const rule = { types: ["new", "price_drop"] as ChangeType[], minDropPct: 5 };
  const filters = { cabins: null, minSeats: 2 };

  it("keeps only the types the route asked for", () => {
    const changes = [
      change({ type: "new", key: "a" }),
      change({ type: "more_seats", key: "b" }),
    ];
    const out = selectAlertable(changes, new Set(["a", "b"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("drops a change the route's own filters would hide", () => {
    // The key is absent from the finds query, so the route's pane would not show
    // it — an email about it would contradict the app.
    const changes = [change({ type: "new", key: "a" }), change({ type: "new", key: "b" })];
    const out = selectAlertable(changes, new Set(["a"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("applies the minimum drop percentage", () => {
    const small = change({ type: "price_drop", key: "a", milesCost: 98, previousMilesCost: 100 });
    const big = change({ type: "price_drop", key: "b", milesCost: 80, previousMilesCost: 100 });
    const out = selectAlertable([small, big], new Set(["a", "b"]), rule, filters);
    expect(out.map((c) => c.key)).toEqual(["b"]);
  });

  it("lets `gone` bypass the find intersection — there is no row left to match", () => {
    // Intersecting would silently drop every disappearance, which is the entire
    // point of the type.
    const gone = change({ type: "gone", key: "a", previousSeats: 4, previousMilesCost: 100 });
    const out = selectAlertable([gone], new Set(), { types: ["gone"], minDropPct: 5 }, filters);
    expect(out.map((c) => c.key)).toEqual(["a"]);
  });

  it("still filters `gone` on what the summary carries", () => {
    const wrongCabin = change({ type: "gone", key: "a", cabin: "economy", previousSeats: 4 });
    const tooFewSeats = change({ type: "gone", key: "b", previousSeats: 1 });
    const out = selectAlertable(
      [wrongCabin, tooFewSeats],
      new Set(),
      { types: ["gone"], minDropPct: 5 },
      { cabins: ["business"], minSeats: 2 },
    );
    expect(out).toEqual([]);
  });

  it("drops a `gone` for an award the route's point limit hid anyway", () => {
    // It was over the ceiling while it existed, so the pane never showed it and
    // its disappearance is not this route's news.
    const tooDear = change({ type: "gone", key: "a", previousSeats: 4, previousMilesCost: 90_000 });
    const affordable = change({ type: "gone", key: "b", previousSeats: 4, previousMilesCost: 50_000 });
    // An unpriced summary passes: refusing what we cannot price would silently
    // drop real disappearances, which is what `gone` exists to catch.
    const unpriced = change({ type: "gone", key: "c", previousSeats: 4 });
    const out = selectAlertable(
      [tooDear, affordable, unpriced],
      new Set(),
      { types: ["gone"], minDropPct: 5 },
      { cabins: null, minSeats: 2, pointLimit: 60_000 },
    );
    expect(out.map((c) => c.key)).toEqual(["b", "c"]);
  });

  it("de-duplicates a key seen twice across passes", () => {
    const a = change({ type: "new", key: "a" });
    const out = selectAlertable([a, a], new Set(["a"]), rule, filters);
    expect(out).toHaveLength(1);
  });

  it("pins the first-match-wins shadow: a drop WITH more seats classifies as more_seats", () => {
    // diffAvailability checks seats before price (diff.ts), so this event never
    // reaches a route that enabled price_drop but not more_seats. Changing the
    // classifier would change changes_json for the alert sweep too, so the behaviour is
    // documented in the UI rather than fixed — and pinned here so a future
    // change breaks a test instead of an inbox.
    const shadowed = change({
      type: "more_seats",
      key: "a",
      milesCost: 80,
      previousMilesCost: 100,
      seatsAvailable: 4,
      previousSeats: 2,
    });
    const out = selectAlertable([shadowed], new Set(["a"]), rule, filters);
    expect(out).toEqual([]);
  });
});
