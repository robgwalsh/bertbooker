import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, CircularProgress, Stack, Tab, Tabs } from "@mui/material";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import FlightTakeoffRoundedIcon from "@mui/icons-material/FlightTakeoffRounded";
import HotelRoundedIcon from "@mui/icons-material/HotelRounded";
import AccountBalanceWalletRoundedIcon from "@mui/icons-material/AccountBalanceWalletRounded";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import { api } from "../../api";
import { PagePad } from "../../components/PagePad";
import { STICKY_NAV_TOP } from "../../lib/layout";
import { useIsNarrow } from "../../hooks/useBreakpoints";
import { AirlinesSection } from "./AirlinesSection";
import { CurrenciesSection } from "./CurrenciesSection";
import { ProgramsSection } from "./ProgramsSection";
import { Airports } from "./airports/AirportsPane";

/** Left-hand nav for the library. Each entry owns the whole content area, so a
 *  wide surface (the airline table, the airports map) gets the full width of the
 *  shell instead of competing with the other sections for vertical space.
 *
 *  These labels are load-bearing for the UI harness: `e2e/pages.spec.ts` finds
 *  the airports pane by `getByRole("tab", { name: "Airports" })`. */
const LIBRARY_TABS = [
  { key: "currencies", label: "Currencies", icon: <AccountBalanceWalletRoundedIcon /> },
  {
    key: "airline-programs",
    label: "Airline programs",
    icon: <FlightRoundedIcon sx={{ transform: "rotate(45deg)" }} />,
  },
  { key: "airlines", label: "Airlines", icon: <FlightTakeoffRoundedIcon /> },
  { key: "hotels", label: "Hotel programs", icon: <HotelRoundedIcon /> },
  { key: "airports", label: "Airports", icon: <PublicRoundedIcon /> },
] as const;

export function Library() {
  const [tab, setTab] = useState(0);
  // The tab column becomes a scrollable strip below `md` — see the `Tabs` below.
  const narrow = useIsNarrow();
  const programsQ = useQuery({ queryKey: ["programs"], queryFn: api.programs });
  const currenciesQ = useQuery({ queryKey: ["currencies"], queryFn: api.currencies });
  // Static reference data — fetch once per session, like the airport geo set.
  const airlinesQ = useQuery({
    queryKey: ["airlines"],
    queryFn: api.airlines,
    staleTime: Infinity,
  });

  const active = LIBRARY_TABS[tab]?.key ?? "currencies";

  // Airports renders even when the programs/currencies fetch is still in flight
  // or has failed — it shares no data with them. Only the program-backed panes
  // wait.
  function panel() {
    if (active === "airports") {
      // The Airports pane hits a ~72k-row reference table and a world geo dump —
      // fine for local dev, not worth serving in production right now. Gated on
      // Vite's build-time DEV flag rather than a server call, since this is a
      // client-only UI decision with nothing to ask the Worker.
      if (!import.meta.env.DEV) {
        return (
          <Alert severity="info">
            The Airports pane is temporarily offline and will return soon.
          </Alert>
        );
      }
      return <Airports />;
    }
    if (programsQ.isLoading || currenciesQ.isLoading)
      return (
        <Stack sx={{ py: 8, alignItems: "center" }}>
          <CircularProgress />
        </Stack>
      );
    if (programsQ.error)
      return <Alert severity="error">Failed to load programs: {String(programsQ.error)}</Alert>;
    if (!programsQ.data) return null;

    const programs = programsQ.data;
    switch (active) {
      case "currencies":
        return <CurrenciesSection currencies={currenciesQ.data ?? []} programs={programs} />;
      case "airline-programs":
        return (
          <ProgramsSection
            title="Airline programs"
            icon={<FlightRoundedIcon sx={{ color: "secondary.main", transform: "rotate(45deg)" }} />}
            programs={programs.filter((p) => p.kind === "airline")}
          />
        );
      case "airlines":
        return <AirlinesSection airlines={airlinesQ.data ?? []} programs={programs} />;
      case "hotels":
        return (
          <ProgramsSection
            title="Hotel programs"
            icon={<HotelRoundedIcon sx={{ color: "secondary.main" }} />}
            programs={programs.filter((p) => p.kind === "hotel")}
          />
        );
      default:
        return null;
    }
  }

  // A document, not a workbench — so unlike the Routes page it asks the shell
  // for the page margin and the scroll container.
  return (
    <PagePad>
    <Stack
      direction={{ xs: "column", md: "row" }}
      spacing={{ xs: 2, md: 3 }}
      sx={{ alignItems: { md: "flex-start" } }}
    >
      {/* A column beside the content from `md` up; a scrollable strip above it
          below that. This follows the seam `STICKY_NAV_TOP` already names — "a
          nav is only pinned from `md` up" — to its conclusion: under that width
          it should not be a COLUMN either. A 190px rail on a 390px screen left
          about 150px for the pane it was navigating.

          One `Tabs` with a branched `orientation`, never two hidden by `sx`:
          `orientation` and `variant` are props rather than styles, and two tab
          lists would put two `role="tab"` nodes named "Airports" in the document
          — which is both wrong for a screen reader and ambiguous for the UI
          harness's landmarks. */}
      <Tabs
        orientation={narrow ? "horizontal" : "vertical"}
        variant={narrow ? "scrollable" : "standard"}
        scrollButtons="auto"
        allowScrollButtonsMobile
        value={tab}
        onChange={(_, v: number) => setTab(v)}
        sx={{
          flexShrink: 0,
          minWidth: { md: 190 },
          maxWidth: "100%",
          // Pinned at its own resting position, the same as the Routes rail —
          // the content pane scrolls past a tab column that never moves.
          position: { md: "sticky" },
          top: { md: STICKY_NAV_TOP },
          // The rule follows the orientation: it is the edge this nav shares
          // with the pane, so it is on the right of a column and under a strip.
          borderRight: { md: 1 },
          borderBottom: { xs: 1, md: 0 },
          borderColor: "divider",
          "& .MuiTab-root": {
            minHeight: 44,
            gap: 1.25,
            // Left-aligned only as a column. A horizontal strip centres its own
            // labels, and forcing them left just makes the icons ragged.
            alignItems: { md: "flex-start" },
            justifyContent: { md: "flex-start" },
            textAlign: { md: "left" },
          },
        }}
      >
        {LIBRARY_TABS.map((t) => (
          <Tab key={t.key} label={t.label} icon={t.icon} iconPosition="start" />
        ))}
      </Tabs>

      {/* minWidth: 0 keeps the wide tables and the map from forcing the flex row
          (and with it the whole page) into a horizontal scroll. */}
      <Box sx={{ flex: 1, minWidth: 0 }}>{panel()}</Box>
    </Stack>
    </PagePad>
  );
}
