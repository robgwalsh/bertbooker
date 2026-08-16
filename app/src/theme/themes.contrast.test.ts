import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@mui/material/styles";
import { buildTheme } from "./build";
import { THEMES } from "./themes";

/**
 * Legibility, checked as arithmetic instead of by eye.
 *
 * Twenty-one palettes is more than anyone will re-inspect after a tweak, and the
 * failure mode is not a crash — it is one theme where the muted text or a status
 * colour quietly can't be read, which nobody notices until they pick that theme
 * and assume the app is broken.
 *
 * **Asserted on the BUILT theme, not on the catalog**, because the built theme
 * is what gets painted: `buildTheme` nudges the ink roles through `legible` so
 * the catalog can stay faithful to the upstream palettes it names. These are the
 * pairings the app actually puts on screen, at the thresholds `legible` targets:
 * not WCAG AA for body copy, since most of them are chips and 11px labels rather
 * than paragraphs.
 *
 * **`primary` is checked as a GROUND, not as ink.** It is the accent as a fill —
 * a contained button, a checked box — so what has to be legible is
 * `contrastText` sitting ON it. Asserting it like the other roles is what the
 * old build did, and it is exactly the assertion that forced the accent to be
 * lightened until every filled button looked washed out.
 */

/** Primary text on its own page — this one is real prose, so it gets AA. */
const BODY_MIN = 4.5;
/** Secondary text, accents and statuses: labels, chips, table heads. */
const LABEL_MIN = 3.0;
/** A 1px rule only has to be *visible*, not readable. */
const BORDER_MIN = 1.12;
/** Text on a filled ground — a button's label, a selected row. Real words at a
 *  real size, so AA, minus a hair for the couple of palettes whose own selection
 *  colour lands at 4.4 (they ship that way and they read fine). */
const ON_FILL_MIN = 4.3;

describe("theme contrast", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s is legible", (_id, spec) => {
    const { palette } = buildTheme(spec);
    const bg = palette.background.default;
    const surface = palette.background.paper;
    const on = (color: string, ground: string) => getContrastRatio(color, ground);

    // Text on every ground it lands on: the page, a floating panel, the chrome
    // (sidebar and table heads), and a hovered row. `hover` is opaque now, so a
    // row that darkens under the pointer really can take the text with it.
    for (const ground of [bg, surface, spec.chrome, spec.raised, spec.hover]) {
      expect(on(palette.text.primary, ground)).toBeGreaterThanOrEqual(BODY_MIN);
    }

    // Every INK role, on either ground it can be set on.
    for (const ground of [bg, surface]) {
      expect(on(palette.text.secondary, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(on(palette.secondary.main, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(on(palette.success.main, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(on(palette.warning.main, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(on(palette.error.main, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(on(palette.info.main, ground)).toBeGreaterThanOrEqual(LABEL_MIN);
    }
    // Table heads are `text.secondary` on the chrome, which is a third ground.
    expect(on(palette.text.secondary, spec.chrome)).toBeGreaterThanOrEqual(LABEL_MIN);

    // The two FILLS, each with the foreground the palette pairs with it.
    expect(on(palette.primary.contrastText, palette.primary.main)).toBeGreaterThanOrEqual(
      ON_FILL_MIN,
    );
    expect(on(spec.onSelected, spec.selected)).toBeGreaterThanOrEqual(ON_FILL_MIN);

    // The chrome has to read as a different plane from the page, and the rule
    // between them has to be seen against both.
    expect(on(palette.divider, bg)).toBeGreaterThanOrEqual(BORDER_MIN);
    expect(on(palette.divider, palette.background.chrome)).toBeGreaterThanOrEqual(
      BORDER_MIN,
    );

    // The three rule weights have to stay in order. They are built three
    // different ways — a literal, an alpha, and a contrast search — so on some
    // palette they could cross over and the app bar would end up with a fainter
    // edge than a table row.
    const chrome = palette.background.chrome;
    expect(on(palette.ruleStrong, chrome)).toBeGreaterThan(on(palette.divider, chrome));
    expect(on(palette.ruleStrong, chrome)).toBeGreaterThanOrEqual(1.45);
    // `ruleSoft` is translucent, so it is compared as it is painted: over the
    // sidebar's own ground, which is what sits behind it.
    expect(on(alphaOver(palette.ruleSoft, chrome), chrome)).toBeLessThan(
      on(palette.divider, chrome),
    );
  });
});

/** Flatten an `rgba()` onto an opaque ground, so a translucent rule can be
 *  measured the way the eye sees it rather than as its own colour. */
function alphaOver(color: string, ground: string): string {
  const c = channels(color);
  const g = channels(ground);
  const a = c[3] ?? 1;
  const mix = (i: number) => Math.round((c[i] ?? 0) * a + (g[i] ?? 0) * (1 - a));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

function channels(color: string): number[] {
  if (color.startsWith("#")) {
    const h = color.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  return color
    .replace(/^rgba?\(|\)$/g, "")
    .split(",")
    .map((n) => Number(n.trim()));
}
