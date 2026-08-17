import {
  createTheme,
  alpha,
  darken,
  getContrastRatio,
  lighten,
  type Theme,
} from "@mui/material/styles";
import {
  DEFAULT_THEME_ID,
  themeById,
  type ThemeMode,
  type ThemeSpec,
} from "./themes";

/**
 * One MUI theme, built from one palette.
 *
 * **The shape of the app lives here; the colours live in `themes.ts`.** Every
 * override below reads `spec`, so the twenty-one themes are twenty-one palettes
 * and not twenty-one layouts — a new theme cannot round a corner, change a
 * density or restyle a table, and every theme therefore gets the same app.
 *
 * That app is an *editor*, not a dashboard, and the difference is four
 * decisions, all of them here:
 *
 * - **Square.** 4px, not 14. Rounded cards are a marketing surface; a pane you
 *   work in has corners.
 * - **Solid rules.** `spec.border` is an opaque colour, never `alpha(muted, .12)`.
 *   A translucent hairline takes on whatever is behind it and dissolves against
 *   a card; VS Code's panel borders are flat lines and they read as structure.
 * - **Chrome is a different colour from the page.** The title bar, the tab strip
 *   and every table head are `spec.chrome`, so the frame reads as frame the way
 *   a title bar does.
 * - **Dense, and flat.** 13px base, tight table rows, no elevation, no glow on
 *   buttons, and no gradient anywhere — not on the body, not on a card, not
 *   behind the app bar.
 *
 * **Nothing here invents a colour any more.** The old build derived its
 * interaction states: a row hover was `alpha(white, 0.035)`, a selected row was
 * the accent at 11%, a filled button was the accent lightened until white could
 * be read on it. Every one of those is a *grey* — a wash carries no hue — which
 * is why nineteen distinct palettes all produced the same slightly-flat app. The
 * palettes now state those colours (`spec.hover`, `spec.selected`,
 * `spec.accent` + `spec.onAccent`), ported from the WPF app that had already
 * tuned them, and this file spends them instead of computing them.
 */

/**
 * The UI typeface.
 *
 * Segoe UI first because this is a Windows app in practice and Segoe UI is
 * *literally* what VS Code's chrome is set in there — nothing else moves the
 * "feel" needle as cheaply. Inter is kept as the next fallback because it is
 * already preloaded in `index.html` and is the closest thing elsewhere.
 */
const UI_FONT =
  '"Segoe UI", Inter, system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';

/**
 * The monospace stack, exported because half this app's content is codes —
 * airport pairs, flight numbers, mileage, dates. Cascadia Mono is VS Code's own
 * bundled face on Windows.
 */
export const MONO_FONT =
  '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", "SF Mono", Menlo, monospace';

/**
 * A wash of the foreground over a surface — the app's "one step raised" idiom.
 *
 * Used narrowly: the map's control chrome and a couple of overlay scrims,
 * where there is no palette token for "slightly lighter than whatever this
 * is". Interaction states are NOT this — a hovered row is `spec.hover`, a
 * chosen one is `spec.selected`. Reach for a token first and this second.
 */
export function tint(theme: Theme, opacity: number): string {
  return alpha(
    theme.palette.mode === "dark" ? theme.palette.common.white : theme.palette.common.black,
    opacity,
  );
}

/** The contrast a small coloured LABEL needs to be worth reading. Below WCAG's
 *  4.5 for body text on purpose: these are bold 11px chips with the word spelled
 *  out beside a mark, and forcing 4.5 turns every brand colour into near-black. */
const MIN_LABEL_CONTRAST = 3.2;

/**
 * A brand colour, nudged until it can actually be read on this theme.
 *
 * The app has a dozen colours that must survive theming because they *identify*
 * something — Bilt's teal, oneworld's gold, business class's indigo. They were
 * all chosen against a near-black page, so on Light+ or Solarized Light the
 * text set in them turns to pale mush; on the very darkest themes the reverse
 * happens to a couple of them.
 *
 * So this keeps the hue and moves only the lightness, one small step at a time,
 * stopping the moment it is legible. Recolouring them per theme instead would
 * make "the teal one" stop meaning Bilt, which is the entire job those colours
 * do in a dense row.
 */
export function readable(color: string, theme: Theme, against?: string): string {
  return legible(color, theme.palette.mode, [
    against ?? theme.palette.background.paper,
  ]);
}

/**
 * The same nudge, before there is a `Theme` to ask.
 *
 * `buildTheme` runs this over the roles that are painted as TEXT — the four
 * statuses, the bright accent, secondary text — against BOTH grounds they can
 * land on. It fires rarely: the ported palettes are contrast
 * tested at their source, and where one of them failed, its author moved the
 * value and left a comment (Tokyo Night's comment grey, Nord's Frost blue). This
 * stays as the backstop for the app's own additions — the hand-picked `success`
 * greens above all — and for the roles this app paints on grounds the file
 * browser never had.
 */
function legible(
  color: string,
  mode: ThemeMode,
  grounds: string[],
  target = MIN_LABEL_CONTRAST,
): string {
  let out = color;
  // Bounded: a colour that cannot reach the target (a mid-grey on a mid-grey
  // theme) settles for the closest it got rather than looping.
  for (let i = 0; i < 6; i++) {
    const worst = Math.min(...grounds.map((g) => getContrastRatio(out, g)));
    if (worst >= target) break;
    out = mode === "light" ? darken(out, 0.12) : lighten(out, 0.12);
  }
  return out;
}

/**
 * How hard the rule under the title bar has to land.
 *
 * `spec.border` is tuned to separate a table row from the next one, which is a
 * job that wants to disappear; the app bar's edge is the boundary between the
 * chrome and everything below it and wants the opposite. 1.6 is roughly a
 * visible-but-quiet line on every palette in the catalog — the minimum a divider
 * must clear is 1.12 (`themes.contrast.test.ts`), so this is meaningfully
 * heavier without becoming a stripe.
 */
const STRONG_RULE_CONTRAST = 1.6;

/** Build the MUI theme for a palette. Pure — `main.tsx` memoizes on the id. */
export function buildTheme(spec: ThemeSpec): Theme {
  const isDark = spec.mode === "dark";
  // Every role painted as text is nudged against both grounds it can land on.
  const role = (color: string) => legible(color, spec.mode, [spec.bg, spec.surface]);
  // The bright accent, as ink: the active tab's stripe, links, focus, a text
  // button's label. Distinct from `spec.accent`, which is a GROUND — see the
  // note at the top of `themes.ts`.
  const ink = role(spec.indicator);

  // Three weights of rule, because the app draws three different KINDS of edge
  // and `divider` alone was doing all of them:
  //
  // - `divider` (spec.border) — the default: row to row, card to page.
  // - `ruleSoft` — a boundary that already reads without help. The sidebar and
  //   the editor are told apart by their GROUND (`chrome` vs `default`), so a
  //   full-strength line there is a second, louder answer to a question the
  //   colour has already settled; VS Code itself draws no line at all between
  //   them. This keeps one, faintly, because at low contrast ratios between
  //   two theme grounds — Solarized Light, Ayu — the ground alone is too subtle.
  // - `ruleStrong` — the one edge that should be unmistakable: the app bar's,
  //   which separates the chrome from the whole application under it.
  const ruleSoft = alpha(spec.border, 0.55);
  // The target is both absolute and RELATIVE: a floor of 1.6 so the edge is
  // visible on the palettes whose border is nearly invisible, and a quarter step
  // above this theme's own divider so it is visibly heavier on the handful whose
  // border already cleared that floor (Night Owl, Catppuccin Mocha). Without the
  // relative half, those themes got the same rule twice and the app bar looked
  // unchanged on exactly the palettes that started out strongest.
  const ruleStrong = legible(
    spec.border,
    spec.mode,
    [spec.chrome, spec.bg],
    Math.max(
      STRONG_RULE_CONTRAST,
      Math.min(getContrastRatio(spec.border, spec.chrome), getContrastRatio(spec.border, spec.bg)) *
        1.25,
    ),
  );

  /**
   * A finger, not a mouse.
   *
   * The one place this app's density bends, and it bends on POINTER rather than
   * on width — which is the whole point. A 390px browser window on a desktop is
   * still driven by a mouse and should keep the 30px controls the rest of the
   * app is drawn at; a phone at the same width cannot hit them. Width would get
   * both of those wrong in opposite directions.
   *
   * It raises HIT AREAS only. The 13px type ramp is the app's identity and stays
   * exactly as it is on every device — see the typography note below.
   *
   * Note this is invisible to `npm run ui:shot`: the harness makes a plain
   * desktop context with no `hasTouch`, so a 390px screenshot shows the mouse
   * sizes. That is a limitation of the picture, not of the rule.
   */
  const COARSE = "@media (pointer: coarse)";

  return createTheme({
    // Carried on the theme so components can reach the raw tokens (`indicator`,
    // `hover`, `selected`) without importing the catalog and guessing which one
    // is live.
    spec,
    palette: {
      mode: spec.mode,
      // `primary` is a GROUND. `main` is what a contained button is painted in
      // and `contrastText` is what survives on top of it — which is why the
      // palette states both rather than letting MUI guess a black-or-white from
      // a colour chosen for legibility as text, not as a fill.
      // Text and outlined buttons opt back out to `ink` below.
      primary: {
        main: spec.accent,
        light: spec.accentHover,
        dark: spec.accentMuted,
        contrastText: spec.onAccent,
      },
      // The bright half of the accent, for anything that says `color="secondary"`
      // and means "the accent, as ink".
      secondary: { main: ink },
      success: { main: role(spec.success) },
      warning: { main: role(spec.warning) },
      error: { main: role(spec.error) },
      info: { main: role(spec.info) },
      background: {
        default: spec.bg,
        paper: spec.surface,
        chrome: spec.chrome,
        raised: spec.raised,
      },
      text: {
        primary: spec.text,
        secondary: role(spec.muted),
        disabled: spec.disabled,
      },
      // Solid, and stated by the palette rather than derived. `action.hover` and
      // `action.selected` are what MUI reaches for in every list, menu, table and
      // button, so pointing them at the theme's own list colours re-tints the
      // whole app in one place — this is most of why the palettes now read as
      // *themes* instead of as nineteen shades of grey wash.
      action: {
        hover: spec.hover,
        selected: spec.selectedIdle,
        disabled: spec.disabled,
        disabledBackground: alpha(spec.disabled, 0.2),
        focus: spec.accentMuted,
      },
      divider: spec.border,
      ruleSoft,
      ruleStrong,
    },
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: UI_FONT,
      // 13px, VS Code's own UI size. MUI's 14 is a *document* size; this is the
      // whole reason the app now reads as dense rather than airy.
      fontSize: 13,
      h1: { fontWeight: 600, letterSpacing: "-0.02em" },
      h2: { fontWeight: 600, letterSpacing: "-0.02em" },
      h3: { fontWeight: 600, letterSpacing: "-0.01em" },
      h4: { fontWeight: 600, letterSpacing: "-0.01em" },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600, fontSize: "0.95rem" },
      button: { textTransform: "none", fontWeight: 500 },
      // Editor section headings: small, spaced, shouty. VS Code's sidebar
      // section titles are exactly this.
      overline: { letterSpacing: "0.1em", fontWeight: 600, fontSize: 11 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // Tells the BROWSER which way round this theme is, which is what makes
          // native scrollbars, form controls and the space behind an overscroll
          // follow it. Without this a light theme keeps dark scrollbars.
          ":root": { colorScheme: spec.mode },
          // Flat. There were two fixed radial washes here, anchored at the top
          // corners, and the workbench is what retired them: the sidebar paints
          // its own opaque ground while the editor does not, so the wash showed
          // through one column and not the other and the two panes disagreed
          // about where the light was coming from.
          body: { backgroundColor: spec.bg, backgroundImage: "none" },
          // The editor's own selection colours, not the browser's blue.
          "::selection": { backgroundColor: spec.selected, color: spec.onSelected },
          // VS Code's scrollbar: no track, no radius, a translucent slab that
          // darkens on hover. Square, because everything here is, and
          // translucent because it floats OVER content rather than reserving a
          // gutter beside it — which is also why the palette ships it as an
          // alpha value rather than a solid.
          "*::-webkit-scrollbar": { width: 12, height: 12 },
          "*::-webkit-scrollbar-track": { backgroundColor: "transparent" },
          "*::-webkit-scrollbar-thumb": {
            backgroundColor: spec.scrollThumb,
            border: `3px solid transparent`,
            backgroundClip: "content-box",
          },
          "*::-webkit-scrollbar-thumb:hover": { backgroundColor: spec.scrollThumbHover },
          "*::-webkit-scrollbar-corner": { backgroundColor: "transparent" },
          // One focus ring for the whole app, in the palette's own focus colour.
          ":focus-visible": { outline: `1px solid ${spec.focus}`, outlineOffset: 1 },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundImage: "none",
            border: `1px solid ${spec.border}`,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          // No gradient overlay. A card is a pane, and a pane is one colour.
          root: { backgroundImage: "none" },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            // Opaque, not blurred: a title bar that shows the page through it is
            // the dashboard cue this replaces.
            backgroundColor: spec.chrome,
            color: spec.text,
            // The heaviest rule in the app — see `ruleStrong`. It is what tells
            // you where the chrome stops, and the active tab is the one thing
            // allowed to paint over it (`NavLink` in `router.tsx`).
            borderBottom: `1px solid ${ruleStrong}`,
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 2, minHeight: 30, [COARSE]: { minHeight: 38 } },
          sizeSmall: { minHeight: 26, [COARSE]: { minHeight: 34 } },
        },
        // `variants` rather than the old `containedPrimary`/`outlinedPrimary`
        // slots: MUI dropped the per-variant-per-colour override keys, and this
        // is the replacement it points at.
        variants: [
          {
            props: { variant: "contained", color: "primary" },
            style: {
              backgroundColor: spec.accent,
              color: spec.onAccent,
              "&:hover": { backgroundColor: spec.accentHover },
            },
          },
          // A text or outlined button is a LABEL, so it takes the bright half of
          // the accent; `primary.main` is the ground colour and is far too dark
          // to read as type on most of these palettes.
          {
            props: { variant: "text", color: "primary" },
            style: { color: ink },
          },
          {
            props: { variant: "outlined", color: "primary" },
            style: {
              color: ink,
              borderColor: alpha(ink, 0.5),
              "&:hover": { borderColor: ink, backgroundColor: alpha(ink, 0.08) },
            },
          },
        ],
      },
      MuiIconButton: {
        styleOverrides: {
          root: { borderRadius: 3 },
          sizeSmall: {
            // A 20px icon plus 12 either side is the 44px target a thumb needs.
            [COARSE]: { padding: 12 },
            // …except the ones that live INSIDE a dense field. The autocomplete's
            // own dropdown and clear arrows are chrome on a text input, not
            // controls in their own right, and a thumb-sized version of them
            // bursts the origin/destination fields in the route form.
            "&.MuiAutocomplete-popupIndicator, &.MuiAutocomplete-clearIndicator": {
              padding: 2,
            },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            borderRadius: 2,
            textTransform: "none",
            // A pressed toggle is the accent GROUND, the way a checked toolbar
            // button is in the file browser — not a 12% wash of it.
            "&.Mui-selected": {
              backgroundColor: spec.accent,
              color: spec.onAccent,
              "&:hover": { backgroundColor: spec.accentHover },
            },
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          // Chips carry codes and statuses here, not people. Square them.
          root: { fontWeight: 600, borderRadius: 3 },
          sizeSmall: { height: 20, fontSize: 11 },
          // The default (uncoloured) chip sits on the theme's control ground
          // rather than on a grey wash of the page.
          filled: { backgroundColor: spec.raised, color: spec.text },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 2,
            // A field is its own ground in an editor — VS Code's inputs are a
            // flat slab, not a tinted hole in the panel.
            backgroundColor: spec.inputBg,
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: spec.border },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: spec.focus,
              borderWidth: 1,
            },
          },
          notchedOutline: { borderColor: spec.inputBorder },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: spec.surface,
            color: spec.text,
            border: `1px solid ${spec.border}`,
            borderRadius: 3,
            fontSize: 11.5,
            boxShadow: `0 4px 14px ${alpha("#000000", isDark ? 0.5 : 0.14)}`,
          },
          arrow: { color: spec.surface },
        },
      },
      MuiMenu: {
        styleOverrides: { paper: { borderRadius: 3 } },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            "&.Mui-selected": { backgroundColor: spec.accentMuted },
            "&.Mui-selected:hover": { backgroundColor: spec.accentMuted },
          },
        },
      },
      MuiDialog: {
        styleOverrides: { paper: { borderRadius: 4 } },
      },
      MuiTableCell: {
        styleOverrides: {
          head: {
            // The chrome colour again: a table head is the frame around rows the
            // way a tab strip is the frame around an editor.
            backgroundColor: spec.chrome,
            color: role(spec.muted),
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            borderColor: spec.border,
            paddingTop: 6,
            paddingBottom: 6,
          },
          // Row to row is the palette's INSIDE-a-pane hairline; the full rule is
          // reserved for edges between panes.
          root: { borderColor: spec.borderSubtle },
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            "&:hover": { backgroundColor: spec.hover },
            "&.Mui-selected, &.Mui-selected:hover": { backgroundColor: spec.selectedIdle },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            "&:hover": { backgroundColor: spec.hover },
            // `selectedIdle`, not `selected`: the strong fill is for a list whose
            // rows are plain text. Every list in this app has COLOUR in its rows
            // — cabin chips, airline marks, a green find count — and a saturated
            // ground erases all of it. The file browser draws its own tree the
            // same quiet way; see its screenshot.
            "&.Mui-selected, &.Mui-selected:hover": {
              backgroundColor: spec.selectedIdle,
            },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 34, [COARSE]: { minHeight: 44 } },
          indicator: { backgroundColor: spec.indicator },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 34,
            [COARSE]: { minHeight: 44 },
            textTransform: "none",
            fontWeight: 500,
          },
        },
      },
      MuiLink: {
        styleOverrides: { root: { color: ink, textDecorationColor: alpha(ink, 0.4) } },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: 0, height: 3, backgroundColor: spec.accentMuted },
          bar: { backgroundColor: spec.indicator },
        },
      },
      MuiSwitch: {
        styleOverrides: { root: { "& .MuiSwitch-track": { borderRadius: 10 } } },
      },
      MuiDivider: {
        styleOverrides: { root: { borderColor: spec.border } },
      },
    },
  });
}

/** The theme for a stored preference id, falling back to the default. */
export function themeFor(id: string | undefined): Theme {
  return buildTheme(themeById(id));
}

/** The app's out-of-the-box look, for anything that needs a theme before the
 *  preference store has been read. */
export const theme = themeFor(DEFAULT_THEME_ID);

declare module "@mui/material/styles" {
  interface Theme {
    /** The palette this theme was built from. Read it for tokens MUI has no
     *  home for — `indicator`, `hover` and `selected` above all. */
    spec: ThemeSpec;
  }
  interface ThemeOptions {
    spec?: ThemeSpec;
  }
  /** Two more grounds alongside `default` (the page) and `paper` (a floating
   *  pane): `chrome` is the frame — title bar, tab strip, table heads — and
   *  `raised` is a control strip inside a pane. */
  interface TypeBackground {
    chrome: string;
    raised: string;
  }
  /** Two more weights of `divider` — see the note where they are built. Plain
   *  strings, exactly like `divider` itself, so `createTheme` passes them
   *  through untouched rather than trying to augment them into a colour. */
  interface Palette {
    ruleSoft: string;
    ruleStrong: string;
  }
  interface PaletteOptions {
    ruleSoft?: string;
    ruleStrong?: string;
  }
}
