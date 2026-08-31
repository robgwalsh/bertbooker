import { Outlet, useParams } from "@tanstack/react-router";
import { Box, Stack } from "@mui/material";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import { PagePad } from "../../PagePad";
import { SectionNav, SectionNavLink, type SectionNavItem } from "../../SectionNav";
import { ReachPanel } from "./ReachPanel";
import { CoveragePane } from "./CoveragePane";
import { PairLookup } from "./PairLookup";

/**
 * The Tools page's three tabs, and the three different questions they answer:
 * do MY routes go anywhere anyone watches (reach), what does THIS program fly
 * (coverage), and who flies THIS PAIR (lookup).
 *
 * They were three stacked sections of one Library tab. Splitting them is what a
 * URL per section buys — the coverage pane alone carries a map, a 200-row table
 * and four filters, and it used to push the pair lookup below two screens of it.
 *
 * The labels are the section headings they already had, unchanged, so the nav
 * entry and the page's own title read as the same thing.
 */
export const TOOLS_TABS = [
  { key: "tracked-routes", label: "Validate Routes", icon: <PublicRoundedIcon /> },
  { key: "coverage", label: "Data coverage", icon: <HubRoundedIcon /> },
  { key: "pair-lookup", label: "Who flies this pair?", icon: <AltRouteRoundedIcon /> },
] as const satisfies readonly SectionNavItem[];

/** Where `/tools` lands. Exported for the same reason `DEFAULT_LIBRARY_TAB` is:
 *  the shell redirects to it without knowing which tab happens to be first. */
export const DEFAULT_TOOLS_TAB = TOOLS_TABS[0].key;

/**
 * The Tools page: the working surfaces over the seats.aero route graph.
 *
 * Split out of the Library, which is a shelf of reference data — programs,
 * airlines, currencies, airports — while every one of these asks a live question
 * of a cache the app fills itself. It is also the one page outside Routes that
 * can spend a metered call, which is a property a page should wear rather than
 * hide in one tab of six.
 *
 * A document like the Library, so it takes its margin and its scroll container
 * from `PagePad` rather than owning panes of its own.
 */
export function Tools() {
  return (
    <PagePad>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={{ xs: 2, md: 3 }}
        sx={{ alignItems: { md: "flex-start" } }}
      >
        <SectionNav label="Tools sections">
          {TOOLS_TABS.map((t) => (
            <SectionNavLink key={t.key} to="/tools/$tab" params={{ tab: t.key }}>
              {t.icon}
              {t.label}
            </SectionNavLink>
          ))}
        </SectionNav>
        {/* minWidth: 0 keeps the coverage map and its table from forcing the
            flex row — and with it the whole page — into a horizontal scroll. */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Outlet />
        </Box>
      </Stack>
    </PagePad>
  );
}

/**
 * The open tool.
 *
 * An unrecognised `$tab` falls back to the default rather than rendering
 * nothing, the same rule the Library panel and `validateRoutesSearch` follow for
 * untrusted pieces of a URL.
 */
export function ToolsPanel() {
  const { tab } = useParams({ from: "/tools/$tab" });
  switch (tab) {
    case "coverage":
      return <CoveragePane />;
    case "pair-lookup":
      return <PairLookup />;
    default:
      return <ReachPanel />;
  }
}
