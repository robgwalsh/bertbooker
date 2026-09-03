import { Outlet, useParams } from "@tanstack/react-router";
import { Box, Stack } from "@mui/material";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import MarkEmailReadRoundedIcon from "@mui/icons-material/MarkEmailReadRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import { PagePad } from "../../PagePad";
import { SectionNav, SectionNavLink, type SectionNavItem } from "../../SectionNav";
import { AlertsOverview } from "./AlertsOverview";
import { SentMailPanel } from "./SentMailPanel";
import { SweepHistoryPanel } from "./SweepHistoryPanel";

/**
 * The Alerts page's three sections, and the three questions they answer: is the
 * sweep working and what is it about to do (alerts), what has it done (sweep
 * history), and what came of that (sent mail).
 *
 * **`key` is the URL segment**, so these are three real routes under `/alerts`
 * rather than three values of a `useState` — linkable, reload-safe, and
 * answerable by the back button.
 *
 * The two history tables are fifteen rows each and were stacked under the
 * cadence panel and the routes table, which is what pushed the things you can
 * act on off the screen. A section each also means neither table is fetched
 * until someone asks for it.
 */
export const ALERTS_TABS = [
  { key: "overview", label: "Alerts", icon: <NotificationsActiveRoundedIcon /> },
  { key: "sweep-history", label: "Sweep history", icon: <HistoryRoundedIcon /> },
  { key: "sent-mail", label: "Sent mail", icon: <MarkEmailReadRoundedIcon /> },
] as const satisfies readonly SectionNavItem[];

/** Where `/alerts` lands. Exported for the same reason `DEFAULT_TOOLS_TAB` is:
 *  the shell redirects to it without knowing which section happens to be
 *  first. */
export const DEFAULT_ALERTS_TAB = ALERTS_TABS[0].key;

/**
 * The Alerts shell: the nav, and whichever section's route is open.
 *
 * A DOCUMENT, not a workbench, so it takes its margin and its scroll container
 * from `PagePad` (see the `Layout` docblock in router.tsx). It owns no query and
 * no state — each section fetches what it alone needs.
 */
export function AlertsPage() {
  return (
    <PagePad>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={{ xs: 2, md: 3 }}
        sx={{ alignItems: { md: "flex-start" } }}
      >
        <SectionNav label="Alerts sections">
          {ALERTS_TABS.map((t) => (
            <SectionNavLink key={t.key} to="/alerts/$tab" params={{ tab: t.key }}>
              {t.icon}
              {t.label}
            </SectionNavLink>
          ))}
        </SectionNav>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Outlet />
        </Box>
      </Stack>
    </PagePad>
  );
}

/**
 * The open section.
 *
 * An unrecognised `$tab` falls back to the default rather than rendering
 * nothing, the same rule the Library and Tools panels follow for untrusted
 * pieces of a URL.
 */
export function AlertsPanel() {
  const { tab } = useParams({ from: "/alerts/$tab" });
  switch (tab) {
    case "sweep-history":
      return <SweepHistoryPanel />;
    case "sent-mail":
      return <SentMailPanel />;
    default:
      return <AlertsOverview />;
  }
}
