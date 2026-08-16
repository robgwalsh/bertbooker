import { describe, expect, it } from "vitest";
import type { ChangeSummary, ChangeType } from "../diff.js";
import {
  describeChange,
  digestSubject,
  escapeHtml,
  groupForRecipients,
  renderDigest,
} from "./digest.js";

const change = (over: Partial<ChangeSummary> & { type: ChangeType; key: string }): ChangeSummary => ({
  flightDate: "2026-11-14",
  program: "alaska",
  cabin: "business",
  origin: "SEA",
  destination: "NRT",
  ...over,
});

describe("escapeHtml", () => {
  it("neutralises markup", () => {
    // Every value interpolated into the digest comes out of a database filled by
    // parsing other people's payloads.
    expect(escapeHtml(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });
});

describe("describeChange", () => {
  it("names the route, date, program and cabin", () => {
    const s = describeChange(change({ type: "new", key: "k", milesCost: 60000, seatsAvailable: 2 }));
    expect(s).toContain("SEA→NRT");
    expect(s).toContain("2026-11-14");
    expect(s).toContain("Alaska"); // resolved from PROGRAM_SEEDS, not the raw code
    expect(s).toContain("60,000");
    expect(s).toContain("2 seats");
  });

  it("shows both prices on a drop", () => {
    const s = describeChange(
      change({ type: "price_drop", key: "k", milesCost: 60000, previousMilesCost: 90000 }),
    );
    expect(s).toContain("90,000 → 60,000");
  });

  it("mentions a price that fell alongside a seat increase", () => {
    // The classifier is first-match-wins, so a drop coinciding with more seats
    // arrives labelled `more_seats`. Without this the cheaper price — the thing
    // you actually care about — would go unmentioned in the one email about it.
    const s = describeChange(
      change({
        type: "more_seats",
        key: "k",
        seatsAvailable: 4,
        previousSeats: 2,
        milesCost: 60000,
        previousMilesCost: 90000,
      }),
    );
    expect(s).toContain("2 → 4 seats");
    expect(s).toContain("90,000 → 60,000");
  });

  it("survives a summary with no origin/destination", () => {
    // changes_json blobs written before those fields existed.
    const s = describeChange(
      change({ type: "gone", key: "k", origin: undefined, destination: undefined, previousMilesCost: 1 }),
    );
    expect(s).toContain("gone");
    expect(s).not.toContain("undefined");
  });
});

describe("digestSubject", () => {
  const g = (n: number, label = "SEA → NRT") => ({
    routeId: 1,
    label,
    changes: Array.from({ length: n }, (_, i) => change({ type: "new" as const, key: `k${i}` })),
  });

  it("names the route when there is only one", () => {
    expect(digestSubject({ groups: [g(3)], quiet: [] })).toBe(
      "BertBooker — 3 changes on SEA → NRT",
    );
  });

  it("counts routes when there are several", () => {
    expect(digestSubject({ groups: [g(2), g(1, "PDX → HND")], quiet: [] })).toBe(
      "BertBooker — 3 changes across 2 routes",
    );
  });

  it("singularises one change", () => {
    expect(digestSubject({ groups: [g(1)], quiet: [] })).toContain("1 change on");
  });
});

describe("renderDigest", () => {
  const input = {
    groups: [
      {
        routeId: 1,
        label: "SEA → NRT",
        changes: [change({ type: "new", key: "a", milesCost: 60000, seatsAvailable: 2 })],
      },
    ],
    quiet: ["PDX → HND"],
    appUrl: "https://bertbooker.example.com",
  };

  it("renders both a text and an HTML body", () => {
    const out = renderDigest(input);
    expect(out.text).toContain("SEA → NRT");
    expect(out.text).toContain("[New]");
    expect(out.html).toContain("<h2");
    expect(out.html).toContain("60,000");
  });

  it("names the routes that were checked and were quiet", () => {
    // "Three routes checked, two quiet" and "only one route ran" are different
    // facts, and no failure email exists to tell them apart.
    const out = renderDigest(input);
    expect(out.text).toContain("Also checked, nothing new: PDX → HND");
    expect(out.html).toContain("PDX → HND");
  });

  it("escapes interpolated values in the HTML", () => {
    const out = renderDigest({ groups: [{ routeId: 1, label: "<b>x</b>", changes: [] }], quiet: [] });
    expect(out.html).not.toContain("<b>x</b>");
    expect(out.html).toContain("&lt;b&gt;");
  });

  it("links back to the app when given a base url", () => {
    expect(renderDigest(input).html).toContain('href="https://bertbooker.example.com"');
  });
});

describe("groupForRecipients", () => {
  const withChange = (key: string) => [change({ type: "new", key })];

  it("gives one recipient one email covering all their routes", () => {
    const out = groupForRecipients([
      { routeId: 1, label: "A", recipient: "me@x.com", changes: withChange("a") },
      { routeId: 2, label: "B", recipient: "me@x.com", changes: withChange("b") },
    ]);
    expect(out.size).toBe(1);
    expect(out.get("me@x.com")!.groups).toHaveLength(2);
  });

  it("separates recipients", () => {
    const out = groupForRecipients([
      { routeId: 1, label: "A", recipient: "me@x.com", changes: withChange("a") },
      { routeId: 2, label: "B", recipient: "you@x.com", changes: withChange("b") },
    ]);
    expect([...out.keys()].sort()).toEqual(["me@x.com", "you@x.com"]);
  });

  it("lists a quiet route beside a noisy one", () => {
    const out = groupForRecipients([
      { routeId: 1, label: "A", recipient: "me@x.com", changes: withChange("a") },
      { routeId: 2, label: "B", recipient: "me@x.com", changes: [] },
    ]);
    expect(out.get("me@x.com")!.quiet).toEqual(["B"]);
  });

  it("sends nothing to a recipient whose routes were ALL quiet", () => {
    // There is no news, and this app does not send "still working" mail.
    const out = groupForRecipients([
      { routeId: 1, label: "A", recipient: "me@x.com", changes: [] },
    ]);
    expect(out.size).toBe(0);
  });
});
