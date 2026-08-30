import { describe, expect, it } from "vitest";
import { airportCoords, ftsMatchQuery } from "./airports.js";

/**
 * The one place a search box's text becomes query SYNTAX.
 *
 * fts5 has a query language, so an unescaped token is not merely a bad search —
 * `NEAR`, `OR`, `*`, `^`, `:` and `"` all parse, and a malformed expression is a
 * 500 rather than an empty result. These pin the sanitizing, not the search
 * quality; that is the FTS index's job.
 */
describe("ftsMatchQuery", () => {
  it("prefix-matches each token, which is what an autocomplete is", () => {
    expect(ftsMatchQuery("sfo")).toBe('"sfo"*');
  });

  it("ANDs multiple tokens, by leaving fts5's default connective implicit", () => {
    expect(ftsMatchQuery("san jose")).toBe('"san"* "jose"*');
  });

  it("neutralises fts5's bareword operators", () => {
    // Unquoted, each of these is an operator and the expression means something
    // else entirely — or fails to parse, which is a 500.
    expect(ftsMatchQuery("AND")).toBe('"AND"*');
    expect(ftsMatchQuery("paris OR london")).toBe('"paris"* "OR"* "london"*');
    expect(ftsMatchQuery("NEAR NOT")).toBe('"NEAR"* "NOT"*');
  });

  it("strips the punctuation fts5 would read as syntax", () => {
    expect(ftsMatchQuery('"quoted"')).toBe('"quoted"*');
    expect(ftsMatchQuery("wild*card")).toBe('"wildcard"*');
    expect(ftsMatchQuery("col:on ^caret (paren)")).toBe('"colon"* "caret"* "paren"*');
    // A hyphen is fts5's NOT. Airport names are full of them.
    expect(ftsMatchQuery("Charles de Gaulle-Roissy")).toBe(
      '"Charles"* "de"* "GaulleRoissy"*',
    );
  });

  it("keeps letters outside ASCII, so accented places still search", () => {
    // The index folds diacritics (remove_diacritics 2), so this finds "Zürich"
    // whichever way it was typed. Stripping non-ASCII here would have broken it.
    expect(ftsMatchQuery("Zürich")).toBe('"Zürich"*');
    expect(ftsMatchQuery("São Paulo")).toBe('"São"* "Paulo"*');
  });

  it("caps the term count", () => {
    // An airport name is not a sentence, and a pasted paragraph should not
    // become a 200-term query.
    const many = ftsMatchQuery("a b c d e f g h i j");
    expect(many!.split(" ")).toHaveLength(6);
  });

  it("is null when nothing survives, rather than an empty MATCH", () => {
    // `airportFilter` turns this into `1 = 0`. An empty MATCH string is a
    // SYNTAX ERROR in fts5, and falling through to no predicate at all would
    // render a page of major airports as though they were search results.
    expect(ftsMatchQuery("!!!")).toBeNull();
    expect(ftsMatchQuery("-")).toBeNull();
    expect(ftsMatchQuery("   ")).toBeNull();
  });
});

// A read-only D1 stub in the style of `routeGraph.test.ts`: it records the SQL
// and the bound arguments and hands back a fixed result set. Nothing here is a
// SQLite engine — the assertions are about the STATEMENT issued.
interface Recorded {
  sql: string;
  args: unknown[];
}

function stubReader(results: unknown[]) {
  const asked: Recorded[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        asked.push({ sql, args });
        return { all: async () => ({ results }) };
      },
    }),
  } as unknown as D1Database;
  return { db, asked };
}

describe("airportCoords", () => {
  it("asks nothing for an empty or all-blank code list", async () => {
    const { db, asked } = stubReader([]);
    expect(await airportCoords(db, [])).toEqual(new Map());
    expect(await airportCoords(db, ["", ""])).toEqual(new Map());
    expect(asked).toHaveLength(0);
  });

  it("dedupes the codes before binding them", async () => {
    const { db, asked } = stubReader([]);
    await airportCoords(db, ["SFO", "ICN", "SFO"]);
    expect(JSON.parse(asked[0]!.args[0] as string)).toEqual(["SFO", "ICN"]);
  });

  it("joins airports directly, so the lookup is a seek rather than a table walk", async () => {
    // This used to assert `GROUP BY iata` — a derived table guarding against
    // duplicate codes. SQLite MATERIALIZEs that per call, walking all 72,454
    // entries of idx_airports_iata to resolve a handful of codes, and the seed
    // has no duplicates to guard against (9,054 codes, 9,054 distinct).
    // `scripts/build-airports.mjs` now fails the build rather than writing one,
    // so the invariant holds where the data is made and this can be a seek.
    const { db, asked } = stubReader([]);
    await airportCoords(db, ["SFO"]);
    expect(asked[0]!.sql).toContain("JOIN airports a ON a.iata = k.value");
    expect(asked[0]!.sql).not.toContain("GROUP BY iata");
  });

  it("drops a null coordinate rather than plotting it at Null Island", async () => {
    // Null Island is in the Gulf of Guinea. Every distance measured from it
    // would be wrong rather than missing, which is the worse failure.
    const { db } = stubReader([
      { iata: "SFO", latitude: 37.6188, longitude: -122.375 },
      { iata: "XXX", latitude: null, longitude: null },
      { iata: "YYY", latitude: 1, longitude: null },
    ]);
    const out = await airportCoords(db, ["SFO", "XXX", "YYY"]);
    expect([...out.keys()]).toEqual(["SFO"]);
    expect(out.get("SFO")).toEqual({ lat: 37.6188, lon: -122.375 });
  });
});
