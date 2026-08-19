import { describe, expect, it } from "vitest";
import { defaultRouteWindow, isoDate } from "./routeWindow";

// One definition of "a new route's window", because two surfaces create routes
// now: the Routes page's form and the Tools page's "Track these legs".

describe("isoDate", () => {
  it("formats through UTC, not the viewer's timezone", () => {
    // A route's window is a pair of bare YYYY-MM-DD strings with no timezone.
    // Reading one back through a local-time Date shifts it by the offset, which
    // lands the window a day out west of Greenwich.
    expect(isoDate(new Date("2026-08-18T00:00:00Z"))).toBe("2026-08-18");
    expect(isoDate(new Date("2026-08-18T23:59:59Z"))).toBe("2026-08-18");
  });
});

describe("defaultRouteWindow", () => {
  it("runs from the given day to a year out", () => {
    // A year because SEATSAERO_HORIZON_DAYS is 365 — the whole window
    // seats.aero has anything to say about.
    expect(defaultRouteWindow(new Date("2026-08-18T12:00:00Z"))).toEqual({
      dateStart: "2026-08-18",
      dateEnd: "2027-08-18",
    });
  });

  it("does not mutate the date it was handed", () => {
    // It builds the end date from the start; doing that in place would move the
    // caller's clock a year forward as a side effect.
    const now = new Date("2026-08-18T12:00:00Z");
    defaultRouteWindow(now);
    expect(now.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  it("lands on a real date across a leap day", () => {
    // 2028 is a leap year; 2029 is not. Setting the year forward from Feb 29
    // must not produce March 1 silently, or the window would be a day off.
    expect(defaultRouteWindow(new Date("2028-02-29T12:00:00Z")).dateEnd).toBe("2029-03-01");
  });
});
