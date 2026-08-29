import { beforeEach, describe, expect, it } from "vitest";
import {
  SourceRegistrationError,
  __resetRegistryForTests,
  listSources,
  registerSource,
} from "./registry.js";
import { isRunnable, type SourceDescriptor } from "./types.js";
import { seatsAeroSource } from "./seatsaero.js";

const descriptor = (over: Partial<SourceDescriptor> = {}): SourceDescriptor => ({
  id: "test",
  label: "Test",
  programs: ["alaska"],
  horizonDays: 30,
  ...over,
});

beforeEach(() => __resetRegistryForTests());

describe("registerSource", () => {
  it("rejects a program that is not seeded", () => {
    // This is the registry's whole live job. `availability_snapshots.program` is
    // a foreign key, so an unseeded program would otherwise surface as a write
    // failing mid-search rather than as a bad registration — and because
    // `sources/index.ts` registers at import time, this fires on Worker boot.
    expect(() => registerSource(descriptor({ programs: ["notaprogram"] }))).toThrow(
      SourceRegistrationError,
    );
    expect(() => registerSource(descriptor({ programs: ["alaska", "nope"] }))).toThrow(/nope/);
  });

  it("rejects a duplicate id from a different source", () => {
    // Two services writing rows under one `availability_snapshots.source` would
    // make a prune delete the wrong data.
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

describe("the built-in catalogue", () => {
  it("registers seats.aero, and its programs are all seeded", () => {
    // The assertion that matters is that this does not throw: every program
    // seats.aero declares has to exist in PROGRAM_SEEDS.
    registerSource(seatsAeroSource);
    expect(listSources().map((s) => s.id)).toEqual(["seatsaero"]);
  });

  it("keeps the id the database stores", () => {
    // `seatsaero` is written into `availability_snapshots.source`, and prunes
    // are scoped per source — so renaming it without migrating that table
    // orphans every row it ever wrote. It was `api:seatsaero` once, and that
    // rename took a migration touching four tables. See docs/SEATS-AERO.md.
    expect(seatsAeroSource.id).toBe("seatsaero");
  });

  it("is descriptor-only — the Worker drives it through its own runner", () => {
    // Not an oversight: `search/run.ts` streams, meters a subrequest budget and
    // resumes across requests, none of which fits a plain `run(task)`.
    expect(isRunnable(seatsAeroSource)).toBe(false);
  });
});
