import { describe, expect, it } from "vitest";
import { AIRLINE_DIRECTORY, AIRLINE_SEEDS, programsForAirline } from "./airlines.js";
import { PROGRAM_SEEDS } from "../../domain/programs.js";

const AIRLINE_PROGRAMS = new Set(PROGRAM_SEEDS.filter((p) => p.kind === "airline").map((p) => p.code));

describe("AIRLINE_SEEDS", () => {
  it("has unique IATA codes", () => {
    const codes = AIRLINE_SEEDS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("only names programs that exist as airline programs", () => {
    for (const a of AIRLINE_SEEDS) {
      for (const code of a.partners) {
        expect(AIRLINE_PROGRAMS.has(code), `${a.code} -> ${code}`).toBe(true);
      }
    }
  });

  it("never lists an alliance-mate as a bilateral partner", () => {
    // Alliance programs are derived; duplicating them here would silently rot
    // the day a program changes alliance.
    for (const a of AIRLINE_SEEDS) {
      if (a.alliance === null) continue;
      const mates = PROGRAM_SEEDS.filter((p) => p.alliance === a.alliance).map((p) => p.code);
      for (const code of a.partners) {
        expect(mates, `${a.code} -> ${code}`).not.toContain(code);
      }
    }
  });

  it("resolves every carrier to at least one program", () => {
    // A carrier no modeled program can book has nothing to say on the Library
    // page — it should be left out of the seed, not listed as unbookable.
    for (const a of AIRLINE_DIRECTORY) {
      expect(a.programs.length, a.code).toBeGreaterThan(0);
    }
  });
});

describe("programsForAirline", () => {
  it("derives the whole alliance without listing it", () => {
    const star = PROGRAM_SEEDS.filter((p) => p.alliance === "star").map((p) => p.code);
    expect(programsForAirline("LH")).toEqual(star);
  });

  it("adds bilateral partners to the alliance set", () => {
    const nh = programsForAirline("NH");
    expect(nh).toContain("ana"); // Star mate
    expect(nh).toContain("virginatlantic"); // bilateral
  });

  it("gives an alliance-less carrier only its bilateral partners", () => {
    expect(programsForAirline("EK").sort()).toEqual(["aeroplan", "emirates", "jetblue", "qantas"]);
  });

  it("returns nothing for an unknown carrier", () => {
    expect(programsForAirline("ZZ")).toEqual([]);
  });
});
