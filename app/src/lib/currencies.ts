// The transfer currencies as a brand system: name, colour, wallet order, and the
// issuer domain behind the mark. No JSX — `CurrencyIcon` and
// `BookableCurrencies` in `components/brand.tsx` are what draw these.

/**
 * The sentinel for "this one has no colour of its own".
 *
 * A palette map is module-scope data and can't call `useTheme`, so the neutral
 * member of each map below is spelled with this and swapped for the live
 * `text.secondary` by `resolveColor` at render. Without it, every
 * "none / unknown / economy" swatch stayed the old dark theme's slate grey —
 * legible on near-black, nearly invisible on Light+.
 *
 * Declared before its first use because these maps are initialized at module
 * load: a `const` referenced above its declaration is a ReferenceError, not a
 * hoist.
 */
export const NEUTRAL_COLOR = "neutral";

/** A palette entry as a colour to paint with, given the live theme. */
export function resolveColor(color: string, mutedColor: string): string {
  return color === NEUTRAL_COLOR ? mutedColor : color;
}

export const CURRENCY_LABEL: Record<string, string> = {
  chase_ur: "Chase",
  capital_one: "Cap One",
  bilt: "Bilt",
  citi_ty: "Citi",
  direct: "Direct",
};

// Accent per transfer currency — the fallback mark's color, and the accent for
// the few places a currency is still named in text.
//
// These stay literal through every theme, and that is the point: they are how
// you tell Chase from Bilt at a glance in a dense row, so they have to mean the
// same thing in Solarized Light as in Dracula. The one exception is `direct`,
// which is not a brand — it is the absence of one.
export const CURRENCY_COLOR: Record<string, string> = {
  chase_ur: "#4f8cff",
  capital_one: "#ff6b6b",
  bilt: "#38e0c8",
  citi_ty: "#c084fc",
  direct: NEUTRAL_COLOR,
};

/** Wallet order, so a row of currency icons reads left-to-right the same
 *  everywhere. Cheap with text labels, load-bearing without them: an icon's
 *  *position* is the only thing left to recognize it by at a glance. */
export function sortCurrencies(codes: string[]): string[] {
  const order = Object.keys(CURRENCY_LABEL);
  return [...codes].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

/** The issuer site behind each currency — the mark `CurrencyIcon` draws.
 *
 *  `direct` (book in the program's own miles, no transfer) has no issuer and is
 *  absent on purpose: it falls through to the colored dot. */
export const CURRENCY_DOMAIN: Record<string, string> = {
  chase_ur: "chase.com",
  capital_one: "capitalone.com",
  bilt: "biltrewards.com",
  citi_ty: "citi.com",
};

export const faviconUrl = (domain: string) => `https://icons.duckduckgo.com/ip3/${domain}.ico`;

// Cabin rank as colour: gold, indigo, teal, and none. Literal for the same
// reason `CURRENCY_COLOR` is — business has to be the same colour in every
// theme or the column stops being scannable — except economy, which is the
// bottom of the ladder and should read as unmarked.
export const CABIN_COLOR: Record<string, string> = {
  first: "#f5c451",
  business: "#7c8cff",
  premium: "#38e0c8",
  economy: NEUTRAL_COLOR,
};
