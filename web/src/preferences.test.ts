import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  serializePreferences,
  type Preferences,
} from "./preferences";
import { DEFAULT_THEME_ID, THEMES } from "./themes";

// Only the PURE half is covered, and that is the whole reason `parsePreferences`
// takes a string instead of reading storage: the web workspace runs vitest in a
// Node environment with no DOM, so there is no `localStorage` to stub. The store
// half is untested for the same reason `auth.ts`'s is.
//
// What these pin is the one property that matters — a browser can never be
// wedged into a broken state by whatever ends up under the key. Every path out
// of here is a valid `Preferences`.

describe("parsePreferences", () => {
  it("defaults when nothing is stored", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("")).toEqual(DEFAULT_PREFERENCES);
  });

  it("defaults on unparseable JSON rather than throwing", () => {
    expect(parsePreferences("{")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("not json at all")).toEqual(DEFAULT_PREFERENCES);
  });

  it("defaults on JSON that isn't an object", () => {
    expect(parsePreferences("null")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("42")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('"showMapColumn"')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("[]")).toEqual(DEFAULT_PREFERENCES);
  });

  it("fills a missing field from the defaults", () => {
    expect(parsePreferences("{}")).toEqual(DEFAULT_PREFERENCES);
  });

  it("reads a stored choice", () => {
    expect(parsePreferences('{"showMapColumn":false}').showMapColumn).toBe(false);
    expect(parsePreferences('{"showMapColumn":true}').showMapColumn).toBe(true);
  });

  it("rejects a wrong-typed field on TYPE, not truthiness", () => {
    // `"yes"` and `0` are a corrupted value, not a considered choice. Coercing
    // them would silently honour whatever got written.
    expect(parsePreferences('{"showMapColumn":"yes"}').showMapColumn).toBe(true);
    expect(parsePreferences('{"showMapColumn":0}').showMapColumn).toBe(true);
    expect(parsePreferences('{"showMapColumn":null}').showMapColumn).toBe(true);
  });

  it("drops unknown keys", () => {
    expect(parsePreferences('{"showMapColumn":false,"bogus":1}')).toEqual({
      ...DEFAULT_PREFERENCES,
      showMapColumn: false,
    });
  });

  it("round-trips through serialize", () => {
    const prefs: Preferences = { showMapColumn: false, themeId: "nord" };
    expect(parsePreferences(serializePreferences(prefs))).toEqual(prefs);
    expect(parsePreferences(serializePreferences(DEFAULT_PREFERENCES))).toEqual(
      DEFAULT_PREFERENCES,
    );
  });
});

// The theme is the one preference whose valid values are a CLOSED SET, so it is
// the one that can be stored wrong in a way that renders nothing. These pin the
// fallback rather than the catalog — a theme may be added or dropped freely, but
// an unknown id must never reach `buildTheme`.
describe("parsePreferences — themeId", () => {
  it("defaults when absent", () => {
    expect(parsePreferences("{}").themeId).toBe(DEFAULT_THEME_ID);
  });

  it("reads any id in the catalog", () => {
    for (const t of THEMES) {
      expect(parsePreferences(JSON.stringify({ themeId: t.id })).themeId).toBe(t.id);
    }
  });

  it("falls back for an id that isn't in the catalog", () => {
    // A theme that was renamed or removed, and the hand-edited case.
    expect(parsePreferences('{"themeId":"solarized-mauve"}').themeId).toBe(DEFAULT_THEME_ID);
    expect(parsePreferences('{"themeId":""}').themeId).toBe(DEFAULT_THEME_ID);
    expect(parsePreferences('{"themeId":42}').themeId).toBe(DEFAULT_THEME_ID);
    expect(parsePreferences('{"themeId":null}').themeId).toBe(DEFAULT_THEME_ID);
  });

  it("the default id is itself in the catalog", () => {
    // Otherwise every browser falls back to a theme that doesn't exist, and the
    // failure only shows up at render.
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });
});
