/**
 * The theme catalog — every look the app can wear, as data.
 *
 * **The palettes are ported from BertBrowser** (a separate, private project of
 * the author's — `BertBrowser.Core/Theming/ThemeCatalog.cs`), token for token,
 * resolved through its one level of inheritance, because that app
 * had already done the work this one was faking. The difference is not the
 * colours — half these names were already here — it is how MANY colours a theme
 * gets to name. A theme used to be twelve, and everything else in the app was
 * derived: a row hover was `alpha(white, 0.035)`, a selected row was the accent
 * at 12%, a filled button was the accent lightened until its label could be read
 * on it. Derived washes are grey, and grey is what "the themes don't look great"
 * meant. A real editor theme states those colours outright — Solarized's
 * selection is `#00596F` and nothing you can compute from `#002B36` will land
 * there — so this catalog states them too.
 *
 * **A theme is still a palette, not a stylesheet.** The *shape* of the app (flat
 * surfaces, square corners, a tab strip instead of pills, dense tables) lives
 * once in `buildTheme` (`theme.ts`) and never varies. Adding a theme is adding a
 * `ThemeSpec` to this array and nothing else, and no theme can restyle a
 * component.
 *
 * Two things the port deliberately kept from the WPF app:
 *
 * - **The accent is a FILL, not a text colour.** `accent` is dark enough to
 *   carry `onAccent` (white, nearly always) — VS Code's `#0E639C`, not its
 *   `#3794FF`. The bright one is `indicator`, and it is the active tab's stripe,
 *   the focus ring and the link. Collapsing the two is what made every filled
 *   button in the old build look washed out: one colour cannot be both the ink
 *   and the ground.
 * - **Contrast is already in the numbers.** BertBrowser's catalog is contrast
 *   tested (`ThemeCatalogTests`), and where a palette's own colour failed, its
 *   author moved it and left a comment saying why — Tokyo Night's comment grey,
 *   Nord's Frost blue, Solarized's hover. Those corrections came across with the
 *   values, which is why `buildTheme` now nudges far less than it used to.
 *
 * This module is PURE and DOM-free on purpose: `preferences.ts` imports
 * `isThemeId` to validate a stored id, and the web workspace runs vitest in Node
 * with no DOM.
 */

export type ThemeMode = "light" | "dark";

/**
 * The palette of one theme.
 *
 * Every field is required, so a new theme cannot be half-defined and fall back
 * to another theme's colour for the one token its author forgot. The field
 * names are this app's; the comment beside each says which BertBrowser token it
 * came from, so the two catalogs can be re-synced without guessing.
 */
export interface ThemeSpec {
  /** Stored in preferences forever — renaming one silently resets that browser
   *  to the default, so treat these as permanent. */
  id: string;
  name: string;
  /** One line, shown under the name in the picker. */
  blurb: string;
  mode: ThemeMode;

  // ── Grounds ───────────────────────────────────────────────────────────────
  /** `Window.Background` — the editor surface: the page, and the table behind
   *  the rows. */
  bg: string;
  /** `Surface.Background` — sidebar, tab strip, table heads. Deliberately a
   *  different colour from `bg`; that difference is what makes chrome read as
   *  chrome. */
  chrome: string;
  /** `Overlay.Background` — what floats: menus, dialogs, popovers, tooltips.
   *  MUI's `background.paper`. */
  surface: string;
  /** `Surface.Raised` — a control strip inside a pane: toolbars, the search
   *  field's neighbourhood, a chip's ground. */
  raised: string;

  // ── Rules ─────────────────────────────────────────────────────────────────
  /** `Border.Default`. Solid, never `alpha(muted, 0.12)` — a translucent
   *  hairline takes on whatever is behind it and dissolves against a card. */
  border: string;
  /** `Border.Subtle` — hairlines *inside* a pane, where the full rule is too
   *  loud (row to row, a section break in a form). */
  borderSubtle: string;
  /** `Border.Focus` — the ring on the focused field. */
  focus: string;

  // ── Ink ───────────────────────────────────────────────────────────────────
  /** `Text.Primary`. */
  text: string;
  /** `Text.Secondary` — the second line of a row, a caption, a table head. */
  muted: string;
  /** `Text.Muted` — section headers and hints; quieter still than `muted`. */
  faint: string;
  /** `Text.Disabled`. */
  disabled: string;

  // ── Accent ────────────────────────────────────────────────────────────────
  /** `Accent.Background` — a FILL that carries `onAccent`. Not a text colour;
   *  see the note at the top of the file. */
  accent: string;
  /** `Accent.HoverBackground`. */
  accentHover: string;
  /** `Accent.Muted` — the accent as a quiet ground: a selected-but-unfocused
   *  row, a filled progress track, the tint behind an active filter. */
  accentMuted: string;
  /** `Text.OnAccent` — what reads on `accent`. */
  onAccent: string;
  /** `Tab.ActiveIndicator` — the BRIGHT one: the open tab's stripe, links,
   *  focus, and anything that has to be seen rather than sat on. */
  indicator: string;

  // ── Rows ──────────────────────────────────────────────────────────────────
  /** `List.HoverBackground` — an opaque colour, not a wash. */
  hover: string;
  /** `List.SelectedBackground`. */
  selected: string;
  /** `List.SelectedForeground`. */
  onSelected: string;
  /** `List.SelectedInactiveBackground` — selected while the pane is not
   *  focused, which in a web app means "chosen, but you're reading elsewhere". */
  selectedIdle: string;

  // ── Tabs ──────────────────────────────────────────────────────────────────
  /** `Tab.InactiveBackground`. */
  tabIdle: string;
  /** `Tab.InactiveForeground`. */
  tabIdleText: string;
  /** `Tab.HoverBackground`. */
  tabHover: string;

  // ── Fields ────────────────────────────────────────────────────────────────
  /** `Input.Background`. */
  inputBg: string;
  /** `Input.Border`. */
  inputBorder: string;

  // ── Scrollbars ────────────────────────────────────────────────────────────
  /** `ScrollBar.Thumb`, converted from WPF's `#AARRGGBB` to CSS's `#RRGGBBAA`.
   *  Translucent on purpose: the thumb floats over content, it does not sit in
   *  a track. */
  scrollThumb: string;
  /** `ScrollBar.ThumbHover`. */
  scrollThumbHover: string;

  // ── Feedback ──────────────────────────────────────────────────────────────
  /** The one role BertBrowser has no token for — a file browser never needs to
   *  say "this went well". Each is the green (or the nearest thing the palette
   *  owns) picked by hand during the port. */
  success: string;
  /** `Warning.Foreground`. */
  warning: string;
  /** `Error.Foreground`. */
  error: string;
  /** `Text.Link`. */
  info: string;
}

/**
 * How the picker groups the catalog.
 *
 * "Core" is the two editor defaults — what you pick when you don't want a
 * personality. "Accessible" holds High Contrast Dark alone, and it is a group of
 * one for the reason BertBrowser lists it last: it is an accessibility setting
 * that happens to be a colour scheme, and filing it beside Dracula invites
 * picking it for the look and then living with a border on everything.
 */
export type ThemeGroup = "Core" | "Dark" | "Light" | "Accessible";

const CORE_THEME_IDS = ["dark-plus", "light-plus"];
const ACCESSIBLE_THEME_IDS = ["high-contrast-dark"];

export function themeGroup(spec: ThemeSpec): ThemeGroup {
  if (CORE_THEME_IDS.includes(spec.id)) return "Core";
  if (ACCESSIBLE_THEME_IDS.includes(spec.id)) return "Accessible";
  return spec.mode === "light" ? "Light" : "Dark";
}

/** Group order in the picker, which is not the array's order: the catalog is
 *  listed dark-first because that is BertBrowser's own picker order, and the
 *  groups are drawn in the order below. */
export const THEME_GROUPS: ThemeGroup[] = ["Core", "Dark", "Light", "Accessible"];

/**
 * What an unconfigured browser gets.
 *
 * Dark+ rather than the old `midnight-aurora`, which this port retired: it was
 * the one palette in the catalog nobody else had tuned, and its whole idea — a
 * near-black slate under a coloured wash — went with the wash. A stored id that
 * no longer exists falls back here on its own (`themeById`), so nothing breaks
 * for a browser that had chosen it; it just wakes up as Dark+.
 */
export const DEFAULT_THEME_ID = "dark-plus";

export const THEMES: ThemeSpec[] = [
  {
    id: "dark-plus",
    name: "Dark+",
    blurb: "The editor default, and the one every other dark theme here is a sheet over.",
    mode: "dark",
    bg: "#1E1E1E",
    chrome: "#252526",
    surface: "#252526",
    raised: "#333333",
    border: "#3C3C3C",
    borderSubtle: "#2B2B2B",
    focus: "#007FD4",
    text: "#CCCCCC",
    muted: "#9D9D9D",
    faint: "#7A7A7A",
    disabled: "#6E6E6E",
    accent: "#0E639C",
    accentHover: "#1177BB",
    accentMuted: "#04395E",
    onAccent: "#FFFFFF",
    indicator: "#007ACC",
    hover: "#2A2D2E",
    selected: "#04395E",
    onSelected: "#FFFFFF",
    selectedIdle: "#37373D",
    tabIdle: "#2D2D2D",
    tabIdleText: "#9D9D9D",
    tabHover: "#333333",
    inputBg: "#3C3C3C",
    inputBorder: "#3C3C3C",
    scrollThumb: "#79797966",
    scrollThumbHover: "#646464B3",
    success: "#89D185",
    warning: "#CCA700",
    error: "#F48771",
    info: "#3794FF",
  },
  {
    id: "light-plus",
    name: "Light+",
    blurb: "The editor default in daylight. Paper white, one blue.",
    mode: "light",
    bg: "#FFFFFF",
    chrome: "#F3F3F3",
    surface: "#FFFFFF",
    raised: "#ECECEC",
    border: "#CECECE",
    borderSubtle: "#E5E5E5",
    focus: "#0090F1",
    text: "#1F1F1F",
    muted: "#616161",
    faint: "#767676",
    disabled: "#A0A0A0",
    accent: "#0F6CBD",
    accentHover: "#0A5A9E",
    accentMuted: "#CCE4F7",
    onAccent: "#FFFFFF",
    indicator: "#007ACC",
    hover: "#E8E8E8",
    selected: "#0F6CBD",
    onSelected: "#FFFFFF",
    selectedIdle: "#E4E6F1",
    tabIdle: "#ECECEC",
    tabIdleText: "#6E6E6E",
    tabHover: "#E3E3E3",
    inputBg: "#FFFFFF",
    inputBorder: "#CECECE",
    scrollThumb: "#64646466",
    scrollThumbHover: "#646464B3",
    success: "#1A7F37",
    warning: "#7A5C00",
    error: "#A31515",
    info: "#0066BF",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    blurb: "Deep indigo, a city at 2am.",
    mode: "dark",
    bg: "#1A1B26",
    chrome: "#16161E",
    surface: "#16161E",
    raised: "#1F2335",
    border: "#292E42",
    borderSubtle: "#1F2335",
    focus: "#7AA2F7",
    text: "#C0CAF5",
    muted: "#A9B1D6",
    faint: "#7C86B8",
    disabled: "#6E6E6E",
    accent: "#3D59A1",
    accentHover: "#4C6BC0",
    accentMuted: "#283457",
    onAccent: "#FFFFFF",
    indicator: "#7AA2F7",
    hover: "#222436",
    selected: "#2E3C64",
    onSelected: "#FFFFFF",
    selectedIdle: "#292E42",
    tabIdle: "#1F2335",
    tabIdleText: "#7C86B8",
    tabHover: "#292E42",
    inputBg: "#16161E",
    inputBorder: "#3B4261",
    scrollThumb: "#565F8999",
    scrollThumbHover: "#7C86B8B3",
    success: "#9ECE6A",
    warning: "#E0AF68",
    error: "#F7768E",
    info: "#7AA2F7",
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    blurb: "Pastel mauve on warm charcoal.",
    mode: "dark",
    bg: "#1E1E2E",
    chrome: "#181825",
    surface: "#181825",
    raised: "#313244",
    border: "#45475A",
    borderSubtle: "#313244",
    focus: "#89B4FA",
    text: "#CDD6F4",
    muted: "#BAC2DE",
    faint: "#9399B2",
    disabled: "#6C7086",
    accent: "#7C4FBF",
    accentHover: "#8F5FD6",
    accentMuted: "#3B2F55",
    onAccent: "#FFFFFF",
    indicator: "#CBA6F7",
    hover: "#292A3C",
    selected: "#45475A",
    onSelected: "#CDD6F4",
    selectedIdle: "#313244",
    tabIdle: "#26273A",
    tabIdleText: "#9399B2",
    tabHover: "#313244",
    inputBg: "#181825",
    inputBorder: "#45475A",
    scrollThumb: "#6C708699",
    scrollThumbHover: "#7F849CCC",
    success: "#A6E3A1",
    warning: "#F9E2AF",
    error: "#F38BA8",
    info: "#89B4FA",
  },
  {
    id: "dracula",
    name: "Dracula",
    blurb: "Purple, pink and that famous green.",
    mode: "dark",
    bg: "#282A36",
    chrome: "#21222C",
    surface: "#21222C",
    raised: "#343746",
    border: "#44475A",
    borderSubtle: "#343746",
    focus: "#BD93F9",
    text: "#F8F8F2",
    muted: "#BFC7E0",
    faint: "#7F8BC0",
    disabled: "#6272A4",
    accent: "#6B4FA8",
    accentHover: "#7C5DC4",
    accentMuted: "#3B3352",
    onAccent: "#FFFFFF",
    indicator: "#FF79C6",
    hover: "#313442",
    selected: "#44475A",
    onSelected: "#F8F8F2",
    selectedIdle: "#343746",
    tabIdle: "#2E303C",
    tabIdleText: "#7F8BC0",
    tabHover: "#343746",
    inputBg: "#21222C",
    inputBorder: "#44475A",
    scrollThumb: "#6272A499",
    scrollThumbHover: "#8B93C4B3",
    success: "#50FA7B",
    warning: "#F1FA8C",
    error: "#FF5555",
    info: "#8BE9FD",
  },
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    blurb: "Atom's dark, still the most-installed theme there is.",
    mode: "dark",
    bg: "#282C34",
    chrome: "#21252B",
    surface: "#21252B",
    raised: "#2C313A",
    border: "#3E4451",
    borderSubtle: "#2C313A",
    focus: "#61AFEF",
    text: "#ABB2BF",
    muted: "#9DA5B4",
    faint: "#7F8797",
    disabled: "#5C6370",
    accent: "#3A6DA8",
    accentHover: "#4680C2",
    accentMuted: "#2B3B52",
    onAccent: "#FFFFFF",
    indicator: "#61AFEF",
    hover: "#2F343E",
    selected: "#3E4451",
    onSelected: "#FFFFFF",
    selectedIdle: "#2F343E",
    tabIdle: "#2C313A",
    tabIdleText: "#7F8797",
    tabHover: "#333944",
    inputBg: "#21252B",
    inputBorder: "#3E4451",
    scrollThumb: "#5C637099",
    scrollThumbHover: "#7F8797CC",
    success: "#98C379",
    warning: "#E5C07B",
    error: "#E06C75",
    info: "#61AFEF",
  },
  {
    id: "nord",
    name: "Nord",
    blurb: "Arctic blue-grey, low contrast on purpose.",
    mode: "dark",
    bg: "#2E3440",
    chrome: "#272C36",
    surface: "#2E3440",
    raised: "#3B4252",
    border: "#434C5E",
    borderSubtle: "#3B4252",
    focus: "#88C0D0",
    text: "#ECEFF4",
    muted: "#D8DEE9",
    faint: "#9BA5B7",
    disabled: "#767F91",
    accent: "#4C6E99",
    accentHover: "#5E81AC",
    accentMuted: "#3B4A5E",
    onAccent: "#FFFFFF",
    indicator: "#88C0D0",
    hover: "#363D4C",
    selected: "#3F5C85",
    onSelected: "#ECEFF4",
    selectedIdle: "#3B4252",
    tabIdle: "#333945",
    tabIdleText: "#9BA5B7",
    tabHover: "#3B4252",
    inputBg: "#272C36",
    inputBorder: "#434C5E",
    scrollThumb: "#616E88AA",
    scrollThumbHover: "#7B88A3CC",
    success: "#A3BE8C",
    warning: "#EBCB8B",
    error: "#BF616A",
    info: "#88C0D0",
  },
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    blurb: "Soft greens, a forest floor.",
    mode: "dark",
    bg: "#2D353B",
    chrome: "#232A2E",
    surface: "#232A2E",
    raised: "#343F44",
    border: "#475258",
    borderSubtle: "#343F44",
    focus: "#A7C080",
    text: "#D3C6AA",
    muted: "#BFB697",
    faint: "#9DA9A0",
    disabled: "#859289",
    accent: "#45604F",
    accentHover: "#527A5F",
    accentMuted: "#2E3E35",
    onAccent: "#FFFFFF",
    indicator: "#A7C080",
    hover: "#343F44",
    selected: "#3D5546",
    onSelected: "#ECE3D0",
    selectedIdle: "#3D484D",
    tabIdle: "#2F383D",
    tabIdleText: "#9DA9A0",
    tabHover: "#343F44",
    inputBg: "#232A2E",
    inputBorder: "#475258",
    scrollThumb: "#859289AA",
    scrollThumbHover: "#9DA9A0CC",
    success: "#A7C080",
    warning: "#DBBC7F",
    error: "#E67E80",
    info: "#7FBBB3",
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    blurb: "Retro warmth — brown, mustard and burnt orange.",
    mode: "dark",
    bg: "#282828",
    chrome: "#1D2021",
    surface: "#1D2021",
    raised: "#3C3836",
    border: "#504945",
    borderSubtle: "#3C3836",
    focus: "#FE8019",
    text: "#EBDBB2",
    muted: "#D5C4A1",
    faint: "#A89984",
    disabled: "#7C6F64",
    accent: "#AF3A03",
    accentHover: "#C64E13",
    accentMuted: "#4A2A16",
    onAccent: "#FFFFFF",
    indicator: "#FE8019",
    hover: "#32302F",
    selected: "#504945",
    onSelected: "#FBF1C7",
    selectedIdle: "#3C3836",
    tabIdle: "#32302F",
    tabIdleText: "#A89984",
    tabHover: "#3C3836",
    inputBg: "#1D2021",
    inputBorder: "#504945",
    scrollThumb: "#928374AA",
    scrollThumbHover: "#A89984CC",
    success: "#B8BB26",
    warning: "#FABD2F",
    error: "#FB4934",
    info: "#83A598",
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    blurb: "Slate blue with an amber accent.",
    mode: "dark",
    bg: "#1F2430",
    chrome: "#191E2A",
    surface: "#191E2A",
    raised: "#232834",
    border: "#33415E",
    borderSubtle: "#232834",
    focus: "#FFAD66",
    text: "#CCCAC2",
    muted: "#B3B1A8",
    faint: "#8A93A0",
    disabled: "#5C6773",
    accent: "#FFAD66",
    accentHover: "#FFBE85",
    accentMuted: "#3A3126",
    onAccent: "#1F2430",
    indicator: "#FFAD66",
    hover: "#262C3A",
    selected: "#33415E",
    onSelected: "#FFFFFF",
    selectedIdle: "#2A3140",
    tabIdle: "#232834",
    tabIdleText: "#8A93A0",
    tabHover: "#2A3140",
    inputBg: "#191E2A",
    inputBorder: "#33415E",
    scrollThumb: "#5C677399",
    scrollThumbHover: "#8A93A0CC",
    success: "#BAE67E",
    warning: "#FFCC66",
    error: "#FF6666",
    info: "#73D0FF",
  },
  {
    id: "night-owl",
    name: "Night Owl",
    blurb: "Built for people who code late.",
    mode: "dark",
    bg: "#011627",
    chrome: "#01111F",
    surface: "#01111F",
    raised: "#0B2942",
    border: "#1D3B53",
    borderSubtle: "#0B2942",
    focus: "#82AAFF",
    text: "#D6DEEB",
    muted: "#B7C3D6",
    faint: "#8494A8",
    disabled: "#637777",
    accent: "#1E5E8C",
    accentHover: "#2A76AE",
    accentMuted: "#0E3450",
    onAccent: "#FFFFFF",
    indicator: "#7FDBCA",
    hover: "#0A2138",
    selected: "#1D3B53",
    onSelected: "#FFFFFF",
    selectedIdle: "#0B2942",
    tabIdle: "#061C2E",
    tabIdleText: "#8494A8",
    tabHover: "#0B2942",
    inputBg: "#01111F",
    inputBorder: "#1D3B53",
    scrollThumb: "#63777799",
    scrollThumbHover: "#8494A8CC",
    success: "#ADDB67",
    warning: "#ECC48D",
    error: "#EF5350",
    info: "#7FDBCA",
  },
  {
    id: "cobalt2",
    name: "Cobalt2",
    blurb: "Saturated blue, yellow accents, no apologies.",
    mode: "dark",
    bg: "#193549",
    chrome: "#122738",
    surface: "#122738",
    raised: "#1F4662",
    border: "#2E5C7E",
    borderSubtle: "#1F4662",
    focus: "#FFC600",
    text: "#FFFFFF",
    muted: "#C9DCE8",
    faint: "#93B0C4",
    disabled: "#6C8CA3",
    accent: "#FFC600",
    accentHover: "#FFD333",
    accentMuted: "#3E3413",
    onAccent: "#12242F",
    indicator: "#FFC600",
    hover: "#1E4058",
    selected: "#1B5E9E",
    onSelected: "#FFFFFF",
    selectedIdle: "#234A66",
    tabIdle: "#163A50",
    tabIdleText: "#93B0C4",
    tabHover: "#1F4662",
    inputBg: "#122738",
    inputBorder: "#2E5C7E",
    scrollThumb: "#6C8CA399",
    scrollThumbHover: "#93B0C4CC",
    success: "#3AD900",
    warning: "#FFC600",
    error: "#FF628C",
    info: "#FFC600",
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    blurb: "Muted rose over natural pine.",
    mode: "dark",
    bg: "#191724",
    chrome: "#1F1D2E",
    surface: "#1F1D2E",
    raised: "#26233A",
    border: "#403D52",
    borderSubtle: "#26233A",
    focus: "#C4A7E7",
    text: "#E0DEF4",
    muted: "#B8B4D0",
    faint: "#908CAA",
    disabled: "#6E6A86",
    accent: "#31748F",
    accentHover: "#3D8AA8",
    accentMuted: "#223541",
    onAccent: "#FFFFFF",
    indicator: "#EB6F92",
    hover: "#211F30",
    selected: "#403D52",
    onSelected: "#E0DEF4",
    selectedIdle: "#26233A",
    tabIdle: "#211F30",
    tabIdleText: "#908CAA",
    tabHover: "#26233A",
    inputBg: "#1F1D2E",
    inputBorder: "#403D52",
    scrollThumb: "#6E6A86AA",
    scrollThumbHover: "#908CAACC",
    success: "#9CCFD8",
    warning: "#F6C177",
    error: "#EB6F92",
    info: "#9CCFD8",
  },
  {
    id: "synthwave",
    name: "Synthwave",
    blurb: "Magenta on violet, cranked all the way up.",
    mode: "dark",
    bg: "#1E1A2E",
    chrome: "#171327",
    surface: "#171327",
    raised: "#2A2440",
    border: "#3A3159",
    borderSubtle: "#2A2440",
    focus: "#FF7EDB",
    text: "#EDE7FF",
    muted: "#C6B8F0",
    faint: "#9B8CC9",
    disabled: "#6F63A0",
    accent: "#A32C86",
    accentHover: "#BE3A9E",
    accentMuted: "#3D1E38",
    onAccent: "#FFFFFF",
    indicator: "#FF7EDB",
    hover: "#272141",
    selected: "#472F73",
    onSelected: "#FFFFFF",
    selectedIdle: "#2A2440",
    tabIdle: "#241F3A",
    tabIdleText: "#9B8CC9",
    tabHover: "#2A2440",
    inputBg: "#171327",
    inputBorder: "#3A3159",
    scrollThumb: "#9B8CC999",
    scrollThumbHover: "#C6B8F0CC",
    success: "#72F1B8",
    warning: "#FEDE5D",
    error: "#FE4450",
    info: "#36F9F6",
  },
  {
    id: "matrix",
    name: "Matrix",
    blurb: "Phosphor green on near-black. Only.",
    mode: "dark",
    bg: "#04100A",
    chrome: "#020A06",
    surface: "#020A06",
    raised: "#0A1C10",
    border: "#14432A",
    borderSubtle: "#0A2A14",
    focus: "#33FF66",
    text: "#79FF9F",
    muted: "#4FD97A",
    faint: "#35A85B",
    disabled: "#2A6B41",
    accent: "#0E7A33",
    accentHover: "#12933F",
    accentMuted: "#072B14",
    onAccent: "#FFFFFF",
    indicator: "#33FF66",
    hover: "#0A1F12",
    selected: "#0E4A22",
    onSelected: "#D6FFE2",
    selectedIdle: "#0A2A14",
    tabIdle: "#071A0E",
    tabIdleText: "#35A85B",
    tabHover: "#0A2A14",
    inputBg: "#020A06",
    inputBorder: "#14432A",
    scrollThumb: "#2A8B4B99",
    scrollThumbHover: "#4FD97ACC",
    success: "#33FF66",
    warning: "#E8FF5A",
    error: "#FF5F56",
    info: "#33FF66",
  },
  {
    id: "monokai",
    name: "Monokai",
    blurb: "The Sublime classic: olive, lime and hot pink.",
    mode: "dark",
    bg: "#272822",
    chrome: "#1E1F1C",
    surface: "#1E1F1C",
    raised: "#34352F",
    border: "#4A4B44",
    borderSubtle: "#34352F",
    focus: "#A6E22E",
    text: "#F8F8F2",
    muted: "#B4B392",
    faint: "#96958A",
    disabled: "#6E6E6E",
    accent: "#5B5A45",
    accentHover: "#6E6C53",
    accentMuted: "#3E3D32",
    onAccent: "#FFFFFF",
    indicator: "#A6E22E",
    hover: "#3E3D32",
    selected: "#49483E",
    onSelected: "#F8F8F2",
    selectedIdle: "#3E3D32",
    tabIdle: "#34352F",
    tabIdleText: "#96958A",
    tabHover: "#3E3D32",
    inputBg: "#1E1F1C",
    inputBorder: "#4A4B44",
    scrollThumb: "#79797966",
    scrollThumbHover: "#646464B3",
    success: "#A6E22E",
    warning: "#E6DB74",
    error: "#F92672",
    info: "#66D9EF",
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    blurb: "Ethan Schoonover's palette, the teal half.",
    mode: "dark",
    bg: "#002B36",
    chrome: "#00212B",
    surface: "#00212B",
    raised: "#073642",
    border: "#0B4453",
    borderSubtle: "#073642",
    focus: "#268BD2",
    text: "#93A1A1",
    muted: "#839496",
    faint: "#657B83",
    disabled: "#6E6E6E",
    accent: "#1F6F9E",
    accentHover: "#2A82B5",
    accentMuted: "#004052",
    onAccent: "#FFFFFF",
    indicator: "#268BD2",
    hover: "#01323F",
    selected: "#00596F",
    onSelected: "#FDF6E3",
    selectedIdle: "#073642",
    tabIdle: "#073642",
    tabIdleText: "#839496",
    tabHover: "#01323F",
    inputBg: "#00212B",
    inputBorder: "#0B4453",
    scrollThumb: "#79797966",
    scrollThumbHover: "#646464B3",
    success: "#859900",
    warning: "#B58900",
    error: "#DC322F",
    info: "#268BD2",
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    blurb: "The same pastels, poured over cream.",
    mode: "light",
    bg: "#EFF1F5",
    chrome: "#E6E9EF",
    surface: "#FFFFFF",
    raised: "#DCE0E8",
    border: "#BCC0CC",
    borderSubtle: "#DCE0E8",
    focus: "#1E66F5",
    text: "#4C4F69",
    muted: "#5C5F77",
    faint: "#6C6F85",
    disabled: "#9CA0B0",
    accent: "#8839EF",
    accentHover: "#9A52F5",
    accentMuted: "#E5D5FB",
    onAccent: "#FFFFFF",
    indicator: "#8839EF",
    hover: "#E6E9EF",
    selected: "#8839EF",
    onSelected: "#FFFFFF",
    selectedIdle: "#DDD6F3",
    tabIdle: "#DCE0E8",
    tabIdleText: "#6C6F85",
    tabHover: "#D3D8E2",
    inputBg: "#FFFFFF",
    inputBorder: "#BCC0CC",
    scrollThumb: "#7C7F9380",
    scrollThumbHover: "#6C6F85B3",
    success: "#40A02B",
    warning: "#A56A00",
    error: "#D20F39",
    info: "#1E66F5",
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    blurb: "Rosé Pine with the lights on.",
    mode: "light",
    bg: "#FAF4ED",
    chrome: "#FFFAF3",
    surface: "#FFFAF3",
    raised: "#F2E9E1",
    border: "#DFDAD9",
    borderSubtle: "#F2E9E1",
    focus: "#286983",
    text: "#575279",
    muted: "#797593",
    faint: "#837E93",
    disabled: "#9893A5",
    accent: "#286983",
    accentHover: "#327D9B",
    accentMuted: "#DDE9EE",
    onAccent: "#FFFFFF",
    indicator: "#B4637A",
    hover: "#F2E9E1",
    selected: "#286983",
    onSelected: "#FFFFFF",
    selectedIdle: "#EADCE6",
    tabIdle: "#EDE5DC",
    tabIdleText: "#797593",
    tabHover: "#E6DBD2",
    inputBg: "#FFFAF3",
    inputBorder: "#DFDAD9",
    scrollThumb: "#79759380",
    scrollThumbHover: "#575279B3",
    success: "#286983",
    warning: "#8C5A00",
    error: "#B4637A",
    info: "#286983",
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    blurb: "The other half — warm paper, same accents.",
    mode: "light",
    bg: "#FDF6E3",
    chrome: "#EEE8D5",
    surface: "#FDF6E3",
    raised: "#E8E1CD",
    border: "#D5CDB6",
    borderSubtle: "#EEE8D5",
    focus: "#268BD2",
    text: "#073642",
    muted: "#586E75",
    faint: "#657B83",
    disabled: "#93A1A1",
    accent: "#1C6EA4",
    accentHover: "#2380BE",
    accentMuted: "#D3E7F5",
    onAccent: "#FFFFFF",
    indicator: "#268BD2",
    hover: "#EEE8D5",
    selected: "#1C6EA4",
    onSelected: "#FDF6E3",
    selectedIdle: "#DDD6C1",
    tabIdle: "#E8E1CD",
    tabIdleText: "#657B83",
    tabHover: "#E0D8C1",
    inputBg: "#FDF6E3",
    inputBorder: "#D5CDB6",
    scrollThumb: "#93A1A199",
    scrollThumbHover: "#657B83B3",
    success: "#5F7A00",
    warning: "#8A6800",
    error: "#DC322F",
    info: "#268BD2",
  },
  {
    id: "high-contrast-dark",
    name: "High Contrast Dark",
    blurb: "Pure black, pure white, and a border on everything.",
    mode: "dark",
    bg: "#000000",
    chrome: "#000000",
    surface: "#000000",
    raised: "#000000",
    border: "#6FC3DF",
    borderSubtle: "#6FC3DF",
    focus: "#F38518",
    text: "#FFFFFF",
    muted: "#DFDFDF",
    faint: "#CFCFCF",
    disabled: "#A0A0A0",
    accent: "#0F4A85",
    accentHover: "#1A5FA5",
    accentMuted: "#0F4A85",
    onAccent: "#FFFFFF",
    indicator: "#F38518",
    hover: "#2E2E2E",
    selected: "#0F4A85",
    onSelected: "#FFFFFF",
    selectedIdle: "#2E2E2E",
    tabIdle: "#000000",
    tabIdleText: "#CFCFCF",
    tabHover: "#2E2E2E",
    inputBg: "#000000",
    inputBorder: "#6FC3DF",
    scrollThumb: "#6FC3DF99",
    scrollThumbHover: "#6FC3DFCC",
    success: "#3FF23F",
    warning: "#FFD700",
    error: "#F48771",
    info: "#6FC3DF",
  },];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Whether a stored preference value names a theme that still exists. Used by
 *  `preferences.ts` to reject anything else, which is what makes a renamed or
 *  removed theme a fallback rather than a blank app. */
export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/** The spec for an id, or the default. Never undefined — the catalog is
 *  guaranteed non-empty and the default is pinned to be in it by
 *  `themes.test.ts`, which is what the trailing `!` rests on. */
export function themeById(id: string | undefined): ThemeSpec {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_THEME_ID) ?? THEMES[0]!;
}
