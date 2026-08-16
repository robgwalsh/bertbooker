import { describe, expect, it } from "vitest";
import { ALERT_HEALTH, alertHealth, formatInterval, type AlertHealth } from "./alerts";
import type { AlertScheduleRoute } from "./api";

// What these pin is PRECEDENCE, not the individual answers. The ladder is
// first-match-wins over four flags that can all be true at once, and three
// surfaces now colour themselves from its result — so the order in which they
// are checked is the whole behaviour, and it is the part a later edit can
// silently reverse.

function route(over: Partial<AlertScheduleRoute> = {}): AlertScheduleRoute {
  return {
    id: 1,
    label: "SEA → NRT",
    chunks: 4,
    windowExpired: false,
    estimatedCalls: 40,
    observedCalls: null,
    alertOn: ["new", "price_drop"],
    alertMinDropPct: 5,
    recipient: "someone@example.com",
    lastAttemptAt: null,
    lastDigestAt: 1,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    due: false,
    awaitingBaseline: false,
    ...over,
  };
}

describe("alertHealth", () => {
  it("is watching when nothing is wrong and nothing is pending", () => {
    expect(alertHealth(route())).toBe("watching");
  });

  it("names each state on its own", () => {
    expect(alertHealth(route({ windowExpired: true }))).toBe("expired");
    expect(alertHealth(route({ consecutiveFailures: 3 }))).toBe("failing");
    expect(alertHealth(route({ awaitingBaseline: true }))).toBe("baseline");
    expect(alertHealth(route({ due: true }))).toBe("due");
  });

  it("reports the most actionable state when several are true", () => {
    // An expired window is why the sweeps are failing, so it is what gets said.
    expect(
      alertHealth(
        route({ windowExpired: true, consecutiveFailures: 2, awaitingBaseline: true, due: true }),
      ),
    ).toBe("expired");
    // A failing route is still due on every tick; "due" would hide the fault.
    expect(alertHealth(route({ consecutiveFailures: 1, due: true }))).toBe("failing");
    // A never-emailed route that is due sweeps SILENTLY, and saying "due" would
    // promise mail that is not coming. See docs/ALERTS.md §5.
    expect(alertHealth(route({ awaitingBaseline: true, due: true }))).toBe("baseline");
  });

  it("has a colour and a sentence for every state it can return", () => {
    const states: AlertHealth[] = ["expired", "failing", "baseline", "due", "watching"];
    for (const s of states) {
      expect(ALERT_HEALTH[s].label).toBeTruthy();
      expect(ALERT_HEALTH[s].help).toBeTruthy();
      expect(ALERT_HEALTH[s].iconColor).toBeTruthy();
    }
  });
});

describe("formatInterval", () => {
  it("stays in minutes under an hour", () => {
    expect(formatInterval(15)).toBe("every 15 min");
    expect(formatInterval(59)).toBe("every 59 min");
  });

  it("switches to hours, and drops a trailing .0", () => {
    expect(formatInterval(60)).toBe("every 1 h");
    expect(formatInterval(120)).toBe("every 2 h");
    expect(formatInterval(90)).toBe("every 1.5 h");
  });
});
