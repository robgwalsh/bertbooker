import { describe, expect, it } from "vitest";
import { ftsMatchQuery } from "./airports.js";

/**
 * The one place a search box's text becomes query SYNTAX.
 *
 * fts5 has a query language, so an unescaped token is not merely a bad search —
 * `NEAR`, `OR`, `*`, `^`, `:` and `"` all parse, and a malformed expression is a
 * 500 rather than an empty result. These pin the sanitizing, not the search
 * quality; that is the FTS index's job (migration 0006).
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
