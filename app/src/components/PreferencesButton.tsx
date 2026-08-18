import { useState } from "react";
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import { normalizeAirportCode, setPreference, usePreferences } from "../lib/preferences";
import { AirportAutocomplete } from "./AirportAutocomplete";
import { THEMES, THEME_GROUPS, themeGroup, type ThemeSpec } from "../theme/themes";
import { SWITCH_ROW_ML } from "../lib/layout";
import { useIsPhone } from "../hooks/useBreakpoints";

/**
 * The app bar's preferences control — the gear and the dialog behind it.
 *
 * One component for both halves because the dialog has exactly one opener and
 * nothing else can reach it; splitting them would mean lifting an `open` boolean
 * into `Layout`, which has no other reason to know about preferences.
 *
 * It sits beside `QuotaIndicator` and `SignOut` for the same reason those do:
 * these are properties of the APP, not of a page. A preference reached from the
 * Routes page would be a preference you couldn't change while looking at what it
 * affects from anywhere else.
 *
 * Why the toggles write immediately and there is no Save: a preference is not a
 * form. There is nothing to validate, nothing to fail, and nothing that reads
 * consistently only once several fields agree — so a commit step would be pure
 * ceremony, and the one thing in this app that has it. `Close` dismisses; it
 * does not confirm.
 */
export function PreferencesButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip title="Preferences">
        <IconButton size="small" aria-label="Preferences" onClick={() => setOpen(true)}>
          <SettingsRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <PreferencesDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PreferencesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePreferences();
  const phone = useIsPhone();

  return (
    // `sm`, not `xs`: the theme picker is a grid of previews, and at `xs` it is
    // one column of nineteen — a list you scroll rather than a palette you scan.
    //
    // On an actual phone the answer is neither of those: the dialog goes full
    // screen and the SWATCHES get narrower (see `ThemePicker`), which keeps two
    // columns and a real scroller instead of a 326px box holding twenty-one
    // previews.
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={phone}>
      <DialogTitle>Preferences</DialogTitle>
      <DialogContent dividers>
        {/* Grouped from the first preference rather than once there are enough to
            need it: a flat list would have to be re-grouped later, and the
            heading is what tells you what KIND of thing this dialog holds. */}
        <Section title="Display">
          <FormControlLabel
            sx={{ ml: SWITCH_ROW_ML }}
            control={
              <Switch
                size="small"
                checked={prefs.showMapColumn}
                onChange={(e) => setPreference("showMapColumn", e.target.checked)}
              />
            }
            label="Show Map column"
          />
          {/* The scope is still spelled out even though the Routes page is
              the only table that draws finds — a "Show X" switch reads as
              app-wide, and naming where it applies costs one line. */}
          <Typography variant="caption" color="text.secondary">
            The route map drawn beside each itinerary on the Routes page.
          </Typography>
        </Section>

        <Divider sx={{ my: 2.5 }} />

        <Section title="Travel">
          <DefaultAirportField value={prefs.defaultAirport} />
        </Section>

        <Divider sx={{ my: 2.5 }} />

        <Section title="Theme">
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5 }}>
            Applies immediately and is remembered per browser. Each swatch is the
            theme's own chrome, page and accent, in the arrangement the app uses
            them.
          </Typography>
          <ThemePicker selected={prefs.themeId} />
        </Section>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The airport this browser starts from.
 *
 * An `AirportAutocomplete` rather than a text box, so the stored value is
 * always a real code that came from the airports table — the same control the
 * Routes page uses to pick a route's endpoints, which is also what makes
 * "PIT" and "Pittsburgh" the same answer here.
 *
 * Writes on selection, like every other control in this dialog: a preference is
 * not a form, and there is nothing here that could fail validation late.
 */
function DefaultAirportField({ value }: { value: string }) {
  return (
    <>
      <AirportAutocomplete
        label="Default airport"
        value={value}
        onChange={(code) => setPreference("defaultAirport", normalizeAirportCode(code))}
        sx={{ maxWidth: 360, mt: 0.5 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75 }}>
        Where searches start from. Seeds the seats.aero tab&rsquo;s route filter; clear it to
        start from nowhere in particular.
      </Typography>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <Typography variant="overline" color="text.secondary" sx={{ display: "block" }}>
        {title}
      </Typography>
      <Stack sx={{ mt: 0.5 }}>{children}</Stack>
    </>
  );
}

function ThemePicker({ selected }: { selected: string }) {
  return (
    <Stack spacing={2}>
      {/* Group order lives in the catalog (`THEME_GROUPS`), beside the function
          that assigns them — two lists in two files drift, and the symptom is a
          whole group that silently stops rendering. */}
      {THEME_GROUPS.map((group) => {
        const themes = THEMES.filter((t) => themeGroup(t) === group);
        if (!themes.length) return null;
        return (
          <Box key={group}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 0.75, fontWeight: 700 }}
            >
              {group}
            </Typography>
            <Box
              sx={{
                display: "grid",
                gap: 1,
                // Narrower swatches on a phone so the picker stays a grid you
                // scan rather than a column you scroll: 128px gives two columns
                // at 390, where 150 gives one.
                gridTemplateColumns: {
                  xs: "repeat(auto-fill, minmax(128px, 1fr))",
                  sm: "repeat(auto-fill, minmax(150px, 1fr))",
                },
              }}
            >
              {themes.map((spec) => (
                <ThemeSwatch key={spec.id} spec={spec} selected={spec.id === selected} />
              ))}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * One theme, as the app drawn small.
 *
 * A row of colour chips would be quicker to build and would not answer the only
 * question being asked, which is what the *app* looks like in this theme — the
 * same six hexes read completely differently depending on which is the page and
 * which is the frame. So the preview is the real arrangement: chrome strip with
 * an active tab, page beneath it, a panel, and lines of text in the theme's own
 * ink and accent.
 *
 * Painted from the spec's raw hexes rather than from a nested `ThemeProvider`:
 * nineteen live MUI themes to draw nineteen 60px rectangles is a lot of theme
 * objects for something with no components in it.
 */
function ThemeSwatch({ spec, selected }: { spec: ThemeSpec; selected: boolean }) {
  return (
    <ButtonBase
      onClick={() => setPreference("themeId", spec.id)}
      aria-label={`${spec.name} theme`}
      aria-pressed={selected}
      sx={{
        display: "block",
        textAlign: "left",
        width: "100%",
        borderRadius: 1,
        overflow: "hidden",
        // The selected theme is marked with the ACCENT of the app's current
        // theme, not of the swatch — it is the app saying which one is on, and
        // a ring in the swatch's own colour would be part of the picture.
        border: (t) =>
          selected ? `2px solid ${t.palette.secondary.main}` : `1px solid ${t.palette.divider}`,
        // Keep the box the same size either way, so selecting doesn't reflow the
        // grid by a pixel in every direction.
        p: selected ? 0 : "1px",
        "&:hover": { borderColor: (t) => t.palette.secondary.main },
      }}
    >
      <Box sx={{ bgcolor: spec.bg }}>
        {/* Chrome: the tab strip, with the active tab in the page colour under
            the palette's own indicator — the one detail that makes these read as
            an editor rather than a swatch. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "stretch",
            height: 14,
            bgcolor: spec.chrome,
            borderBottom: `1px solid ${spec.border}`,
          }}
        >
          <Box
            sx={{
              width: 30,
              bgcolor: spec.bg,
              borderTop: `1px solid ${spec.indicator}`,
              borderRight: `1px solid ${spec.border}`,
            }}
          />
          <Box sx={{ width: 24, bgcolor: spec.tabIdle, borderRight: `1px solid ${spec.border}` }} />
        </Box>
        {/* Page: the sidebar on the left with one selected row in it, "code" on
            the right. The selected row is what shows off the stated selection
            colour rather than a wash of the accent. */}
        <Box sx={{ display: "flex", height: 46 }}>
          <Stack
            spacing={0.4}
            sx={{
              width: 34,
              bgcolor: spec.chrome,
              borderRight: `1px solid ${spec.border}`,
              pt: 0.5,
            }}
          >
            <Box sx={{ height: 8, bgcolor: spec.selected }} />
            <Box sx={{ height: 8, bgcolor: spec.hover }} />
          </Stack>
          <Stack spacing={0.6} sx={{ flex: 1, p: 0.85 }}>
            <Bar color={spec.indicator} width="55%" />
            <Bar color={spec.text} width="80%" />
            <Bar color={spec.success} width="40%" />
            <Bar color={spec.muted} width="65%" />
          </Stack>
        </Box>
      </Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ alignItems: "center", px: 1, py: 0.6, minHeight: 34 }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600, fontSize: 12 }}>
            {spec.name}
          </Typography>
          {/* Truncated rather than wrapped: a two-line blurb on one card and a
              one-line blurb on the next makes a ragged grid. The full text is
              the tooltip's job — see the title below. */}
          <Tooltip title={spec.blurb}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
              {spec.blurb}
            </Typography>
          </Tooltip>
        </Box>
        {selected && (
          <CheckRoundedIcon sx={{ fontSize: 16, color: "secondary.main", flexShrink: 0 }} />
        )}
      </Stack>
    </ButtonBase>
  );
}

function Bar({ color, width }: { color: string; width: string }) {
  return <Box sx={{ height: 3, width, bgcolor: color, borderRadius: 0.5, opacity: 0.9 }} />;
}
