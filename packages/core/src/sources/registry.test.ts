import { beforeEach, describe, expect, it } from "vitest";
import {
  SourceRegistrationError,
  __resetRegistryForTests,
  getSource,
  listSources,
  registerSource,
  resolveRunnable,
  runnableSources,
} from "./registry.js";
import { isRunnable, type RunnableSource, type SourceDescriptor } from "./types.js";
import { pointsYeahSource } from "./pointsyeah.js";
import { seatsAeroSource } from "./seatsaero.js";

const descriptor = (over: Partial<SourceDescriptor> = {}): SourceDescriptor => ({
  id: "test",
  label: "Test",
  programs: ["alaska"],
  horizonDays: 30,
  runtime: "worker",
  ...over,
});

const runnable = (over: Partial<RunnableSource> = {}): RunnableSource => ({
  ...descriptor(),
  supports: () => true,
  plan: () => [],
  run: async () => ({ offers: [] }),
  ...over,
});

beforeEach(() => __resetRegistryForTests());

describe("registerSource", () => {
  it("rejects a program that is not seeded", () => {
    // `availability_snapshots.program` is a foreign key, so an unseeded program
    // would otherwise surface as a write failing mid-run rather than as a bad
    // registration.
    expect(() => registerSource(descriptor({ programs: ["notaprogram"] }))).toThrow(
      SourceRegistrationError,
    );
    expect(() => registerSource(descriptor({ programs: ["alaska", "nope"] }))).toThrow(/nope/);
  });

  it("rejects a duplicate id from a different source", () => {
    registerSource(descriptor({ id: "dup" }));
    expect(() => registerSource(descriptor({ id: "dup", label: "Other" }))).toThrow(/duplicate/);
  });

  it("is idempotent for the identical object, so a double import is harmless", () => {
    const s = descriptor({ id: "same" });
    registerSource(s);
    expect(() => registerSource(s)).not.toThrow();
    expect(listSources()).toHaveLength(1);
  });

  it("requires an id", () => {
    expect(() => registerSource(descriptor({ id: "" }))).toThrow(SourceRegistrationError);
  });
});

describe("runtime scoping", () => {
  it("never hands a local source to the worker runner, or the reverse", () => {
    // The safety property: a source pinned to `local` has NOT been shown to work
    // from a datacenter IP, and a Worker running it anyway would quietly return
    // nothing — indistinguishable from "no award space".
    const local = runnable({ id: "local-one", runtime: "local" });
    const worker = runnable({ id: "worker-one", runtime: "worker" });
    registerSource(local);
    registerSource(worker);

    expect(runnableSources("local").map((s) => s.id)).toEqual(["local-one"]);
    expect(runnableSources("worker").map((s) => s.id)).toEqual(["worker-one"]);
  });

  it("excludes descriptor-only sources from the generic runner", () => {
    // seats.aero is a catalogue entry with no `run` — the Worker drives it
    // through its own streaming runner. Handing it to the generic loop would
    // fail at the least useful moment.
    registerSource(descriptor({ id: "descriptor-only" }));
    expect(listSources()).toHaveLength(1);
    expect(runnableSources("worker")).toHaveLength(0);
  });

  it("resolveRunnable explains a wrong-runtime id rather than returning nothing", () => {
    registerSource(runnable({ id: "local-one", runtime: "local" }));
    expect(() => resolveRunnable(["local-one"], "worker")).toThrow(/runs on "local"/);
    expect(() => resolveRunnable(["nosuch"], "local")).toThrow(/unknown source/);
    expect(resolveRunnable(["local-one"], "local").map((s) => s.id)).toEqual(["local-one"]);
  });
});

describe("the built-in catalogue", () => {
  it("registers seats.aero on the worker and PointsYeah locally", () => {
    registerSource(seatsAeroSource);
    const py = registerSource(pointsYeahSource());

    expect(getSource("seatsaero")?.runtime).toBe("worker");
    expect(getSource("pointsyeah")?.runtime).toBe("local");
    // Neither id carries the old harvest taxonomy — those strings are stored in
    // `availability_snapshots.source` and were re-keyed by migration 0009.
    expect(listSources().map((s) => s.id)).toEqual(["pointsyeah", "seatsaero"]);

    expect(isRunnable(py)).toBe(true);
    expect(isRunnable(seatsAeroSource)).toBe(false);
  });

  it("PointsYeah plans nothing beyond its horizon, rather than an empty search", () => {
    // Zero tasks reads as "nothing to do". A task that ran and found nothing
    // would claim coverage for dates it never actually saw.
    const py = pointsYeahSource();
    expect(py.plan({ origin: "SEA", destination: "LAX", dateStart: "2030-01-01", dateEnd: "2030-02-01" }, "2026-08-15")).toEqual([]);

    const soon = py.plan(
      { origin: "SEA", destination: "LAX", dateStart: "2026-08-20", dateEnd: "2026-08-25" },
      "2026-08-15",
    );
    expect(soon).toHaveLength(1);
    expect(soon[0]!.source).toBe("pointsyeah");
    expect(soon[0]!.dates).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
    ]);
  });

  it("PointsYeah declines a run filtered to programs it cannot produce", () => {
    const py = pointsYeahSource();
    expect(py.supports({ origin: "SEA", destination: "LAX", dateStart: "", dateEnd: "" })).toBe(true);
    expect(
      py.supports({ origin: "SEA", destination: "LAX", dateStart: "", dateEnd: "", programs: ["cathay"] }),
    ).toBe(true);
    // `skymiles` is seeded but PointsYeah maps no DL code, so a run filtered to
    // it must not fire a request at all.
    expect(
      py.supports({ origin: "SEA", destination: "LAX", dateStart: "", dateEnd: "", programs: ["skymiles"] }),
    ).toBe(false);
  });
});
