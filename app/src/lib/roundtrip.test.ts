import { describe, expect, it } from "vitest";
import type { Find, TrackedRoute } from "../api";
import {
  DEFAULT_MAX_NIGHTS,
  DEFAULT_MIN_NIGHTS,
  MAX_NIGHTS,
  MAX_NIGHTS_SPAN,
  MAX_WINDOW_NIGHTS,
  collapseLegs,
  pairRoundTrips,
  splitDirections,
  windowNightsFor,
} from "./roundtrip";

function find(p: Partial<Find> & Pick<Find, "origin" | "destination" | "flight_date">): Find {
  return {
    program: "alaska",
    cabin: "business",
    seats_available: 2,
    miles_cost: 60_000,
    cash_fees_cents: 560,
    is_direct: 1,
    source: "seatsaero",
    source_fetched_at: 1_760_000_000_000,
    ...p,
  };
}

function route(p: Partial<TrackedRoute> & Pick<TrackedRoute, "id">): TrackedRoute {
  return {
    origin: "SEA",
    destination: "HND",
    origins: null,
    destinations: null,
    date_start: "2027-03-01",
    date_end: "2027-03-31",
    cabins: null,
    currencies: null,
    min_seats: 2,
    direct_only: 0,
    round_trip: 1,
    last_checked_at: null,
    // Alerts off: this fixture is about round-trip pairing, and a route that
    // schedules itself is a different question entirely.
    alerts_enabled: 0,
    alert_email: null,
    alert_on: null,
    alert_min_drop_pct: 5,
    alert_last_attempt_at: null,
    alert_last_digest_at: null,
    alert_consecutive_failures: 0,
    ...p,
  };
}

const out = (date: string, p: Partial<Find> = {}) =>
  find({ origin: "SEA", destination: "HND", flight_date: date, ...p });
const back = (date: string, p: Partial<Find> = {}) =>
  find({ origin: "HND", destination: "SEA", flight_date: date, ...p });

const NIGHTS = { mode: "nights", minNights: 7, maxNights: 14 } as const;

describe("pairRoundTrips — the nights window", () => {
  it("is inclusive at both ends and excludes either side of it", () => {
    const o = [out("2027-03-01")];
    const kept = [back("2027-03-08"), back("2027-03-15")]; // 7 and 14 nights
    const dropped = [back("2027-03-07"), back("2027-03-16")]; // 6 and 15

    expect(pairRoundTrips(o, kept, NIGHTS).pairs.map((p) => p.nights)).toEqual([7, 14]);
    expect(pairRoundTrips(o, dropped, NIGHTS).pairs).toEqual([]);
  });

  it("never pairs a return that departs before the outbound", () => {
    const r = pairRoundTrips([out("2027-03-10")], [back("2027-03-03")], {
      mode: "nights" as const,
      minNights: 0,
      maxNights: 14,
    });
    expect(r.pairs).toEqual([]);
  });

  it("allows a same-day return only when minNights is 0", () => {
    const o = [out("2027-03-10")];
    const i = [back("2027-03-10")];
    expect(pairRoundTrips(o, i, { mode: "nights", minNights: 0, maxNights: 3 }).pairs).toHaveLength(
      1,
    );
    expect(pairRoundTrips(o, i, { mode: "nights", minNights: 1, maxNights: 3 }).pairs).toEqual([]);
  });
});

describe("pairRoundTrips — which legs may pair", () => {
  it("requires the return to depart from where the outbound landed", () => {
    const o = [find({ origin: "SEA", destination: "NRT", flight_date: "2027-03-01" })];
    const wrongAirport = [back("2027-03-08")]; // HND->SEA, but we landed at NRT
    const right = [find({ origin: "NRT", destination: "SEA", flight_date: "2027-03-08" })];

    expect(pairRoundTrips(o, wrongAirport, NIGHTS).pairs).toEqual([]);
    expect(pairRoundTrips(o, right, NIGHTS).pairs).toHaveLength(1);
  });

  it("leaves the home end free — landing back at a sister airport is a real trip", () => {
    const o = [find({ origin: "SEA", destination: "NRT", flight_date: "2027-03-01" })];
    const i = [find({ origin: "NRT", destination: "PDX", flight_date: "2027-03-08" })];
    expect(pairRoundTrips(o, i, NIGHTS).pairs).toHaveLength(1);
  });

  it("requires the same cabin on both legs", () => {
    const o = [out("2027-03-01", { cabin: "business" })];
    const i = [back("2027-03-08", { cabin: "economy" })];
    expect(pairRoundTrips(o, i, NIGHTS).pairs).toEqual([]);
  });

  // Asserted explicitly because it looks like a bug: booking out on one program
  // and back on another is ordinary, and refusing it would hide the normal case.
  it("pairs ACROSS programs", () => {
    const o = [out("2027-03-01", { program: "virginatlantic" })];
    const i = [back("2027-03-08", { program: "united" })];
    const r = pairRoundTrips(o, i, NIGHTS);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.outbound.program).toBe("virginatlantic");
    expect(r.pairs[0]!.inbound.program).toBe("united");
  });
});

describe("pairRoundTrips — the derived fields", () => {
  it("sums miles and fees, and takes the LOWER seat count", () => {
    const o = [out("2027-03-01", { miles_cost: 60_000, cash_fees_cents: 560, seats_available: 4 })];
    const i = [back("2027-03-08", { miles_cost: 75_000, cash_fees_cents: 1_200, seats_available: 2 })];
    const p = pairRoundTrips(o, i, NIGHTS).pairs[0]!;
    expect(p.totalMiles).toBe(135_000);
    expect(p.totalFeesCents).toBe(1_760);
    expect(p.seats).toBe(2);
    expect(p.cabin).toBe("business");
  });

  it("sorts by total miles, breaking ties on fewer nights", () => {
    const o = [out("2027-03-01")];
    const i = [
      back("2027-03-15", { miles_cost: 50_000, program: "united" }), // 14n, 110k
      back("2027-03-08", { miles_cost: 90_000, program: "aeroplan" }), // 7n, 150k
      back("2027-03-10", { miles_cost: 50_000, program: "qantas" }), // 9n, 110k
    ];
    const r = pairRoundTrips(o, i, NIGHTS);
    expect(r.pairs.map((p) => [p.totalMiles, p.nights])).toEqual([
      [110_000, 9],
      [110_000, 14],
      [150_000, 7],
    ]);
  });
});

describe("collapseLegs", () => {
  it("keeps the cheapest per (pair, date, cabin)", () => {
    const kept = out("2027-03-01", { miles_cost: 60_000, program: "alaska" });
    const dearer = out("2027-03-01", { miles_cost: 75_000, program: "united" });
    expect(collapseLegs([dearer, kept])).toEqual([kept]);
  });

  it("never merges two city pairs — a SEA leg is not a PDX leg", () => {
    const a = find({ origin: "SEA", destination: "NRT", flight_date: "2027-03-01" });
    const b = find({ origin: "PDX", destination: "NRT", flight_date: "2027-03-01" });
    expect(collapseLegs([a, b])).toHaveLength(2);
  });

  it("breaks ties on more seats, then fewer stops, then shorter", () => {
    const few = out("2027-03-01", { seats_available: 2, program: "a" });
    const many = out("2027-03-01", { seats_available: 5, program: "b" });
    expect(collapseLegs([few, many])).toEqual([many]);

    const oneStop = out("2027-03-02", { stop_count: 1, program: "a" });
    const nonstop = out("2027-03-02", { stop_count: 0, program: "b" });
    expect(collapseLegs([oneStop, nonstop])).toEqual([nonstop]);

    const slow = out("2027-03-03", { duration_minutes: 900, program: "a" });
    const quick = out("2027-03-03", { duration_minutes: 600, program: "b" });
    expect(collapseLegs([slow, quick])).toEqual([quick]);
  });

  // stop_count NULL means GENUINELY UNKNOWN, not zero: a summary row from
  // seats.aero says a connecting award exists without saying how many stops.
  it("falls back to is_direct when stop_count is null", () => {
    const unknownButDirect = out("2027-03-01", { stop_count: null, is_direct: 1, program: "a" });
    const knownOneStop = out("2027-03-01", { stop_count: 1, is_direct: 0, program: "b" });
    expect(collapseLegs([knownOneStop, unknownButDirect])).toEqual([unknownButDirect]);

    const unknownConnecting = out("2027-03-02", { stop_count: null, is_direct: 0, program: "a" });
    const knownNonstop = out("2027-03-02", { stop_count: 0, is_direct: 1, program: "b" });
    expect(collapseLegs([unknownConnecting, knownNonstop])).toEqual([knownNonstop]);
  });

  it("absorbs the duplicate rows one find gets when two routes both match it", () => {
    const a = out("2027-03-01", { tracked_route_id: 1 });
    const b = out("2027-03-01", { tracked_route_id: 2 });
    expect(collapseLegs([a, b])).toHaveLength(1);
  });
});

describe("pairRoundTrips — bounds and safety", () => {
  it("drops an outbound with no eligible return rather than showing it alone", () => {
    const r = pairRoundTrips([out("2027-03-01"), out("2027-03-02")], [back("2027-03-09")], NIGHTS);
    expect(r.pairs).toHaveLength(2); // 8n and 7n — both from the one return
    expect(pairRoundTrips([out("2027-06-01")], [back("2027-03-09")], NIGHTS).pairs).toEqual([]);
  });

  it("reports truncation instead of silently capping, keeping the cheapest", () => {
    const outs = Array.from({ length: 20 }, (_, i) =>
      out(`2027-03-${String(i + 1).padStart(2, "0")}`, { miles_cost: 60_000 + i * 1_000 }),
    );
    const backs = outs.map((o) =>
      back(`2027-03-${String(Number(o.flight_date.slice(8)) + 7).padStart(2, "0")}`),
    );
    const r = pairRoundTrips(outs, backs, { ...NIGHTS, limit: 5 });
    expect(r.pairs).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.considered).toBeGreaterThan(5);
    expect(r.pairs[0]!.totalMiles).toBeLessThanOrEqual(r.pairs[4]!.totalMiles);
  });

  it("reports which side was empty", () => {
    const a = pairRoundTrips([], [back("2027-03-08")], NIGHTS);
    expect(a).toMatchObject({ pairs: [], considered: 0, outboundSlots: 0, inboundSlots: 1 });
    const b = pairRoundTrips([out("2027-03-01")], [], NIGHTS);
    expect(b).toMatchObject({ pairs: [], considered: 0, outboundSlots: 1, inboundSlots: 0 });
  });

  // The easiest bug to ship here is an in-place .sort() on a caller's array.
  it("does not mutate its inputs", () => {
    const o = [out("2027-03-02"), out("2027-03-01")];
    const i = [back("2027-03-09"), back("2027-03-08")];
    const oSnap = JSON.parse(JSON.stringify(o));
    const iSnap = JSON.parse(JSON.stringify(i));
    pairRoundTrips(o, i, NIGHTS);
    expect(o).toEqual(oSnap);
    expect(i).toEqual(iSnap);
  });

  it("clamps an absurd nights range instead of hanging", () => {
    const r = pairRoundTrips([out("2027-03-01")], [back("2027-03-08")], {
      mode: "nights" as const,
      minNights: 0,
      maxNights: 4_000,
    });
    expect(r.pairs).toHaveLength(1);
    expect(MAX_NIGHTS_SPAN).toBeLessThan(MAX_NIGHTS + 1);
    expect(MAX_WINDOW_NIGHTS).toBeGreaterThan(MAX_NIGHTS);
  });

  // The slider's span cap is a property of the SLIDER. A caller may legitimately
  // ask a far wider nights question than the slider can express, so capping the
  // span here would silently drop most of the answer.
  it("does not cap the SPAN, only the bounds", () => {
    const r = pairRoundTrips([out("2027-03-01")], [back("2027-06-01")], {
      mode: "nights" as const,
      minNights: 0,
      maxNights: 120, // 92 nights apart — four times MAX_NIGHTS_SPAN
    });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.nights).toBe(92);
  });

  it("stays proportional to slots x span, not to the date cross product", () => {
    const outs = Array.from({ length: 90 }, (_, i) => out(addDays("2027-03-01", i)));
    const backs = Array.from({ length: 104 }, (_, i) => back(addDays("2027-03-01", i)));
    const r = pairRoundTrips(outs, backs, {
      mode: "nights",
      minNights: 7,
      maxNights: 14,
      limit: 1_000,
    });
    // Every outbound day whose return day (+7..+14) is still inside the 104-day
    // return window contributes one pair per night. 90x104 = 9,360 combinations
    // if you cross-product them; the nights filter is applied by construction.
    expect(r.considered).toBe(90 * 8);
    expect(r.outboundSlots).toBe(90);
    expect(r.inboundSlots).toBe(104);
  });
});

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}


describe("splitDirections", () => {
  const r = route({ id: 1, origin: "SEA", destination: "HND" });

  it("splits one round-trip route's finds into the two directions it gathered", () => {
    const o = out("2027-03-01");
    const i = back("2027-03-08");
    expect(splitDirections(r, [o, i])).toEqual({ outbound: [o], inbound: [i] });
  });

  // What makes the route's ORIGINS mean "home". Without the split, pairing would
  // also offer the mirror trip (fly HND->SEA, come back SEA->HND) — a real
  // itinerary, and never the one you meant.
  it("anchors home at the origins, so the mirror trip is not offered", () => {
    const { outbound, inbound } = splitDirections(r, [out("2027-03-01"), back("2027-03-08")]);
    expect(outbound.every((f) => f.origin === "SEA")).toBe(true);
    expect(inbound.every((f) => f.origin === "HND")).toBe(true);
  });

  it("handles multi-airport sets on both sides", () => {
    const wide = route({
      id: 2,
      origins: '["PDX","SEA"]',
      destinations: '["HND","NRT"]',
    });
    const legs = [
      find({ origin: "PDX", destination: "NRT", flight_date: "2027-03-01" }),
      find({ origin: "NRT", destination: "SEA", flight_date: "2027-03-08" }),
    ];
    const { outbound, inbound } = splitDirections(wide, legs);
    expect(outbound).toHaveLength(1);
    expect(inbound).toHaveLength(1);
  });

  it("drops a leg belonging to neither direction", () => {
    const stray = find({ origin: "LAX", destination: "JFK", flight_date: "2027-03-01" });
    expect(splitDirections(r, [stray])).toEqual({ outbound: [], inbound: [] });
  });

  // Overlapping sets are the only way a leg matches both patterns, and for such
  // a route both orientations genuinely are trips. Dropping it from one list
  // would silently empty that side and yield no pairs at all.
  it("puts a leg in BOTH lists when the user typed overlapping sets", () => {
    const sym = route({ id: 3, origins: '["HND","SEA"]', destinations: '["HND","SEA"]' });
    const o = out("2027-03-01");
    const { outbound, inbound } = splitDirections(sym, [o]);
    expect(outbound).toEqual([o]);
    expect(inbound).toEqual([o]);
  });
});

describe("windowNightsFor", () => {
  // How long the whole-window trip IS — quoted in the pane's copy. Not a filter:
  // the default mode names the two dates, and this only measures the gap.
  it("is the span of the route's own window", () => {
    expect(windowNightsFor(route({ id: 1, date_start: "2027-03-01", date_end: "2027-03-31" }))).toBe(
      30,
    );
  });

  it("is 0 for a one-day window, never negative for an inverted one", () => {
    expect(windowNightsFor(route({ id: 1, date_start: "2027-03-01", date_end: "2027-03-01" }))).toBe(
      0,
    );
    expect(windowNightsFor(route({ id: 2, date_start: "2027-03-31", date_end: "2027-03-01" }))).toBe(
      0,
    );
  });
});

// The WHOLE WINDOW reading: out on the window's first day, back on its last, and
// no other pair of dates. Its own describe because it is a different question
// from any nights range — which is the bug these tests exist to pin.
describe("pairRoundTrips — dates mode (whole window)", () => {
  const WINDOW = { mode: "dates", departOn: "2027-03-01", returnOn: "2027-03-31" } as const;

  it("pairs ONLY the window's two endpoint dates", () => {
    const r = pairRoundTrips(
      [out("2027-03-01"), out("2027-03-02"), out("2027-03-31")],
      [back("2027-03-01"), back("2027-03-30"), back("2027-03-31")],
      WINDOW,
    );
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.outbound.flight_date).toBe("2027-03-01");
    expect(r.pairs[0]!.inbound.flight_date).toBe("2027-03-31");
    expect(r.pairs[0]!.nights).toBe(30);
  });

  // The exact regression. A 30-night range over a Mar 1–31 window also accepts
  // Mar 2 -> Apr 1: the same LENGTH, gathered under the same route (Apr 1 can be
  // stored from an overlapping route or a wider earlier window), and a trip on
  // days you did not ask to travel.
  it("refuses a trip of the right length on the wrong dates", () => {
    const shifted = pairRoundTrips([out("2027-03-02")], [back("2027-04-01")], WINDOW);
    expect(shifted.pairs).toEqual([]);
    // Same legs, as a nights range: 30 nights apart, so the old reading kept it.
    const asNights = pairRoundTrips([out("2027-03-02")], [back("2027-04-01")], {
      mode: "nights",
      minNights: 0,
      maxNights: 30,
    });
    expect(asNights.pairs).toHaveLength(1);
  });

  it("is not bounded by the slider's MAX_NIGHTS — a 200-day window is one 200-night trip", () => {
    const r = pairRoundTrips([out("2027-03-01")], [back("2027-09-17")], {
      mode: "dates",
      departOn: "2027-03-01",
      returnOn: "2027-09-17",
    });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.nights).toBe(200);
    expect(r.pairs[0]!.nights).toBeGreaterThan(MAX_NIGHTS);
  });

  it("allows a same-day trip on a one-day window", () => {
    const r = pairRoundTrips([out("2027-03-01")], [back("2027-03-01")], {
      mode: "dates",
      departOn: "2027-03-01",
      returnOn: "2027-03-01",
    });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.nights).toBe(0);
  });

  it("pairs nothing when the window ends before it starts", () => {
    const r = pairRoundTrips([out("2027-03-31")], [back("2027-03-01")], {
      mode: "dates",
      departOn: "2027-03-31",
      returnOn: "2027-03-01",
    });
    expect(r.pairs).toEqual([]);
  });

  // What separates "nothing flies out that day" from "both days have legs that
  // don't join up" — three different pieces of advice in the pane's empty state.
  it("counts the slots on each anchor date, so the miss can be explained", () => {
    const noOutbound = pairRoundTrips([out("2027-03-02")], [back("2027-03-31")], WINDOW);
    expect(noOutbound).toMatchObject({ departDateSlots: 0, returnDateSlots: 1 });

    const bothPresent = pairRoundTrips(
      [find({ origin: "SEA", destination: "NRT", flight_date: "2027-03-01" })],
      [back("2027-03-31")], // HND->SEA, but we landed at NRT
      WINDOW,
    );
    expect(bothPresent).toMatchObject({ pairs: [], departDateSlots: 1, returnDateSlots: 1 });
  });

  it("leaves the anchor-date counts null in nights mode, where they mean nothing", () => {
    const r = pairRoundTrips([out("2027-03-01")], [back("2027-03-08")], NIGHTS);
    expect(r).toMatchObject({ departDateSlots: null, returnDateSlots: null });
  });
});

describe("defaults", () => {
  it("are a sane vacation and inside the SLIDER's bounds", () => {
    expect(DEFAULT_MIN_NIGHTS).toBeLessThan(DEFAULT_MAX_NIGHTS);
    expect(DEFAULT_MAX_NIGHTS).toBeLessThanOrEqual(MAX_NIGHTS);
    expect(DEFAULT_MAX_NIGHTS - DEFAULT_MIN_NIGHTS).toBeLessThanOrEqual(MAX_NIGHTS_SPAN);
  });

  // The nights mode's backstop, which is not the slider's cap: a caller can ask a
  // wider question than the slider can express, and 365 is what any search could
  // ever have gathered.
  it("clamp the nights mode no tighter than a year", () => {
    expect(MAX_WINDOW_NIGHTS).toBeGreaterThanOrEqual(365);
    expect(MAX_WINDOW_NIGHTS).toBeGreaterThan(MAX_NIGHTS);
  });
});
