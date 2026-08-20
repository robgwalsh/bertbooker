import { describe, expect, it } from "vitest";
import { createRouteBody, defaultRouteForm } from "./form";

// `via` is three-valued on the wire and the form is not, which is the whole
// reason this function exists. Absent means "work it out from the route graph";
// an empty array means "no hubs, I mean it". The form always HAS the field, so
// posting it wholesale said "no hubs" on every new route and the auto-fill never
// ran once — a freshly created SFO→KTM just sat there reporting nothing.

describe("createRouteBody", () => {
  it("OMITS via entirely when the field was left empty", () => {
    const body = createRouteBody(defaultRouteForm());
    expect("via" in body).toBe(false);
    // And it must survive JSON, which is what actually reaches the Worker: a
    // key set to `undefined` and a key that is absent are the same on the wire,
    // but only if nobody later "fixes" this to send `undefined` explicitly.
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("via");
  });

  it("sends the hubs when there are hubs", () => {
    const body = createRouteBody({ ...defaultRouteForm(), via: ["ICN", "DEL"] });
    expect(body.via).toEqual(["ICN", "DEL"]);
  });

  it("changes nothing else about the form", () => {
    const form = { ...defaultRouteForm(), origins: ["SFO"], destinations: ["KTM"], minSeats: 4 };
    const body = createRouteBody(form);
    expect(body.origins).toEqual(["SFO"]);
    expect(body.destinations).toEqual(["KTM"]);
    expect(body.minSeats).toBe(4);
    expect(body.dateStart).toBe(form.dateStart);
  });

  it("does not mutate the form it was handed", () => {
    const form = defaultRouteForm();
    const before = JSON.stringify(form);
    createRouteBody(form);
    expect(JSON.stringify(form)).toBe(before);
  });
});
