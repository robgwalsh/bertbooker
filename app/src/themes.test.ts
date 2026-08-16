import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  THEMES,
  THEME_GROUPS,
  isThemeId,
  themeById,
  themeGroup,
  type ThemeSpec,
} from "./themes";

// The catalog is data, so what is worth pinning is the handful of properties a
// typo in that data would break — all of which fail at *render*, in one theme,
// on one browser, rather than at build time.

const COLOR_KEYS: (keyof ThemeSpec)[] = [
  "bg",
  "chrome",
  "surface",
  "raised",
  "border",
  "borderSubtle",
  "focus",
  "text",
  "muted",
  "faint",
  "disabled",
  "accent",
  "accentHover",
  "accentMuted",
  "onAccent",
  "indicator",
  "hover",
  "selected",
  "onSelected",
  "selectedIdle",
  "tabIdle",
  "tabIdleText",
  "tabHover",
  "inputBg",
  "inputBorder",
  "success",
  "warning",
  "error",
  "info",
];

/** The two that are translucent on purpose — the scrollbar floats over content,
 *  so the palette ships them as `#RRGGBBAA`. */
const ALPHA_KEYS: (keyof ThemeSpec)[] = ["scrollThumb", "scrollThumbHover"];

describe("THEMES", () => {
  it("is the whole ported catalog", () => {
    // Pinned because the catalog is a deliverable with a stated size, and a
    // half-finished addition (spec written, picker never checked) reads exactly
    // like a finished one. Twenty-one is BertBrowser's `ThemeCatalog.BuiltIns`.
    expect(THEMES).toHaveLength(21);
  });

  it("has unique ids", () => {
    // A duplicate id makes one of the two unreachable from the picker forever,
    // and `themeById` picks whichever `Map` saw last.
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique names", () => {
    const names = THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every theme every colour, as a hex", () => {
    for (const t of THEMES) {
      for (const key of COLOR_KEYS) {
        expect(t[key], `${t.id}.${String(key)}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      for (const key of ALPHA_KEYS) {
        expect(t[key], `${t.id}.${String(key)}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
      }
    }
  });

  it("keeps a theme's own surfaces distinct", () => {
    // bg === chrome is the specific mistake that erases the frame: the tab strip
    // and table heads stop reading as chrome and the app goes back to looking
    // like a dashboard. High Contrast Dark is the deliberate exception — every
    // surface there is pure black and the structure is carried by borders, which
    // is the entire point of the theme.
    for (const t of THEMES) {
      if (t.id === "high-contrast-dark") continue;
      expect(t.bg, t.id).not.toBe(t.chrome);
      expect(t.border, t.id).not.toBe(t.bg);
      // A hovered row that is the row colour is a hover nobody can see.
      expect(t.hover, t.id).not.toBe(t.bg);
    }
  });

  it("groups every theme, and the picker's order covers all of them", () => {
    const core = THEMES.filter((t) => themeGroup(t) === "Core").map((t) => t.id);
    expect(core).toEqual(["dark-plus", "light-plus"]);
    expect(THEMES.filter((t) => themeGroup(t) === "Accessible").map((t) => t.id)).toEqual([
      "high-contrast-dark",
    ]);
    // Every theme is reachable from the picker, which walks THEME_GROUPS.
    for (const t of THEMES) expect(THEME_GROUPS, t.id).toContain(themeGroup(t));
    for (const group of THEME_GROUPS) {
      expect(THEMES.some((t) => themeGroup(t) === group), group).toBe(true);
    }
  });
});

describe("themeById", () => {
  it("resolves every catalog id to itself", () => {
    for (const t of THEMES) expect(themeById(t.id)).toBe(t);
  });

  it("returns the default rather than undefined for anything else", () => {
    // The promise the whole fallback chain rests on: a stored id that no longer
    // exists still renders an app — which is what every browser that had chosen
    // one of the retired pre-port themes is relying on right now.
    expect(themeById(undefined).id).toBe(DEFAULT_THEME_ID);
    expect(themeById("does-not-exist").id).toBe(DEFAULT_THEME_ID);
    expect(themeById("midnight-aurora").id).toBe(DEFAULT_THEME_ID);
  });
});

describe("isThemeId", () => {
  it("accepts catalog ids and nothing else", () => {
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
    expect(isThemeId("does-not-exist")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(7)).toBe(false);
  });
});
