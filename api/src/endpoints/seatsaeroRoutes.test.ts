import { describe, expect, it } from "vitest";
import { routeFilter } from "./seatsaeroRoutes.js";

// `routeFilter` is the one WHERE builder the graph table and the graph map
// share, which is what keeps them showing the same set. It is exported only so
// this file can reach it — the Hono handlers around it hold no logic worth
// testing, matching the rest of the repo (there are no endpoint-level tests).

const filter = (params: Record<string, string>) => routeFilter((k) => params[k]);

describe("routeFilter", () => {
  it("always scopes to a source, first", () => {
    // Required, unlike `airportFilter`'s browsable default: a route graph is
    // per program by nature.
    const { source, where, binds } = filter({ source: "alaska" });
    expect(source).toBe("alaska");
    expect(where[0]).toBe("r.source = ?");
    expect(binds[0]).toBe("alaska");
  });

  it("pushes one bind per placeholder, in SQL order", () => {
    // The property every caller depends on: they append their own LIMIT bind
    // after these, so a mismatch here silently filters on the wrong values.
    const { where, binds } = filter({
      source: "alaska",
      origin: "sfo",
      originRegion: "Asia",
      minDistance: "1000",
      maxDistance: "3000",
      q: "PIT",
    });
    const placeholders = where.join(" AND ").split("?").length - 1;
    expect(binds).toHaveLength(placeholders);
    expect(binds).toEqual(["alaska", "SFO", "Asia", 1000, 3000, "PIT", "PIT"]);
  });

  describe("free text", () => {
    it("treats three letters as a CODE and nothing else", () => {
      // The regression this exists for. Substring-matching "PIT" against
      // airport names hits "Aspen-PITkin County", "Beijing CaPITal" and
      // "Cherry CaPITal" — so asking for Pittsburgh returned Aspen, Beijing
      // and Traverse City. The default-airport preference produces exactly
      // this kind of token, so it is the common case, not the edge one.
      const { where, binds } = filter({ source: "alaska", q: "PIT" });
      const clause = where.join(" ");
      expect(clause).toContain("r.origin = ?");
      expect(clause).not.toContain("LIKE");
      expect(binds).toEqual(["alaska", "PIT", "PIT"]);
    });

    it("upper-cases a lowercase code", () => {
      expect(filter({ source: "alaska", q: "pit" }).binds).toEqual(["alaska", "PIT", "PIT"]);
    });

    it("searches names and cities for anything longer", () => {
      const { where, binds } = filter({ source: "alaska", q: "pittsburgh" });
      expect(where.join(" ")).toContain("LIKE");
      expect(binds).toEqual([
        "alaska",
        "%pittsburgh%",
        "%pittsburgh%",
        "%pittsburgh%",
        "%pittsburgh%",
      ]);
    });

    it("adds no clause at all when empty", () => {
      expect(filter({ source: "alaska", q: "   " }).where).toEqual(["r.source = ?"]);
    });
  });

  it("ignores a non-numeric distance rather than binding NaN", () => {
    const { where, binds } = filter({ source: "alaska", minDistance: "abc" });
    expect(where).toEqual(["r.source = ?"]);
    expect(binds).toEqual(["alaska"]);
  });
});
