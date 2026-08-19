import { useQuery } from "@tanstack/react-query";
import { Outlet, useParams } from "@tanstack/react-router";
import { Alert, Box, CircularProgress, Stack } from "@mui/material";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import FlightTakeoffRoundedIcon from "@mui/icons-material/FlightTakeoffRounded";
import HotelRoundedIcon from "@mui/icons-material/HotelRounded";
import AccountBalanceWalletRoundedIcon from "@mui/icons-material/AccountBalanceWalletRounded";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import { api } from "../../api";
import { PagePad } from "../../components/PagePad";
import { SectionNav, SectionNavLink, type SectionNavItem } from "../../components/SectionNav";
import { AirlinesSection } from "./AirlinesSection";
import { CurrenciesSection } from "./CurrenciesSection";
import { ProgramsSection } from "./ProgramsSection";
import { Airports } from "./airports/AirportsPane";

/** Left-hand nav for the library. Each entry owns the whole content area, so a
 *  wide surface (the airline table, the airports map) gets the full width of the
 *  shell instead of competing with the other sections for vertical space.
 *
 *  **`key` is the URL segment**, so these are five real routes under `/library`
 *  rather than five values of a `useState`. That is what makes a section
 *  linkable, survive a reload, and answer the back button.
 *
 *  These labels are load-bearing for the UI harness: `e2e/pages.spec.ts` finds
 *  the airports pane by `getByRole("link", { name: "Airports" })`.
 *
 *  Reference data and nothing else. The seats.aero pane used to be a sixth
 *  entry here and is now the Tools page — it was the one tab that was about a
 *  vendor rather than about a catalogue, and the only one that could spend a
 *  metered call. */
export const LIBRARY_TABS = [
  { key: "currencies", label: "Currencies", icon: <AccountBalanceWalletRoundedIcon /> },
  {
    key: "airline-programs",
    label: "Airline programs",
    icon: <FlightRoundedIcon sx={{ transform: "rotate(45deg)" }} />,
  },
  { key: "airlines", label: "Airlines", icon: <FlightTakeoffRoundedIcon /> },
  { key: "hotels", label: "Hotel programs", icon: <HotelRoundedIcon /> },
  { key: "airports", label: "Airports", icon: <PublicRoundedIcon /> },
] as const satisfies readonly SectionNavItem[];

/** Where `/library` lands. Exported so `router.tsx` can redirect to it without
 *  knowing which section happens to be first — the shell wires, it does not
 *  decide. */
export const DEFAULT_LIBRARY_TAB = LIBRARY_TABS[0].key;

/**
 * The Library's shell: the nav, and whichever section's route is open.
 *
 * A document, not a workbench — so unlike the Routes page it asks `PagePad` for
 * the page margin and the scroll container. It owns no queries: those belong to
 * the panel, so that switching sections cannot be blocked by a fetch the
 * section you are opening does not need.
 */
export function Library() {
  return (
    <PagePad>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={{ xs: 2, md: 3 }}
        sx={{ alignItems: { md: "flex-start" } }}
      >
        <SectionNav label="Library sections">
          {LIBRARY_TABS.map((t) => (
            <SectionNavLink key={t.key} to="/library/$tab" params={{ tab: t.key }}>
              {t.icon}
              {t.label}
            </SectionNavLink>
          ))}
        </SectionNav>
        {/* minWidth: 0 keeps the wide tables and the map from forcing the flex
            row (and with it the whole page) into a horizontal scroll. */}
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
 * `$tab` is untrusted input like any other piece of a URL, so an unrecognised
 * value falls back to the default section rather than rendering an empty pane —
 * the same rule `validateRoutesSearch` follows for the Routes page's search
 * params.
 */
export function LibraryPanel() {
  const { tab } = useParams({ from: "/library/$tab" });
  const active = LIBRARY_TABS.some((t) => t.key === tab) ? tab : DEFAULT_LIBRARY_TAB;

  const programsQ = useQuery({ queryKey: ["programs"], queryFn: api.programs });
  const currenciesQ = useQuery({ queryKey: ["currencies"], queryFn: api.currencies });
  // Static reference data — fetch once per session, like the airport geo set.
  const airlinesQ = useQuery({
    queryKey: ["airlines"],
    queryFn: api.airlines,
    staleTime: Infinity,
  });

  // Airports renders even when the programs/currencies fetch is still in flight
  // or has failed — it shares no data with them. Only the program-backed panes
  // wait.
  if (active === "airports") {
    // The Airports pane hits a ~72k-row reference table and a world geo dump —
    // fine for local dev, not worth serving in production right now. Gated on
    // Vite's build-time DEV flag rather than a server call, since this is a
    // client-only UI decision with nothing to ask the Worker.
    if (!import.meta.env.DEV) {
      return (
        <Alert severity="info">The Airports pane is temporarily offline and will return soon.</Alert>
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
      return <CurrenciesSection currencies={currenciesQ.data ?? []} programs={programs} />;
  }
}
