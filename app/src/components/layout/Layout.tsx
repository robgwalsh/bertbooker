import { Box, AppBar, Toolbar, Stack } from "@mui/material";
import { Outlet } from "@tanstack/react-router";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { APP_BAR_HEIGHT } from "../../lib/layout";
import { SettingsButton } from "../settings/SettingsDialog";
import { NavLink } from "./NavLink";
import { AlertsHealthDot } from "./AlertsHealthDot";
import { SignOut } from "./SignOut";
import { QuotaIndicator } from "./QuotaIndicator";

/**
 * The app shell: a title bar with a tab strip in it, and the page under that.
 */
export function Layout() {
  const narrow = useIsPhone();
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" elevation={0} sx={{ flexShrink: 0 }}>
        <Toolbar
          disableGutters
          sx={{
            minHeight: `${APP_BAR_HEIGHT - 1}px !important`,
            alignItems: "stretch",
            overflow: "visible",
          }}
        >
          <Box component="nav" sx={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
            <NavLink to="/" activeOptions={{ exact: true, includeSearch: false }}>
              Routes
            </NavLink>
            <NavLink to="/alerts">
              Alerts
              <AlertsHealthDot />
            </NavLink>
            <NavLink to="/library">Library</NavLink>
            <NavLink to="/tools">Tools</NavLink>
          </Box>
          <Stack
            direction="row"
            spacing={{ xs: 0.5, sm: 1 }}
            data-testid="app-bar-controls"
            sx={{
              ml: "auto",
              alignItems: "center",
              px: { xs: 0.5, sm: 2, lg: 3 },
              flexShrink: 0,
            }}
          >
            {!narrow && <QuotaIndicator />}
            <SettingsButton />
            <SignOut />
          </Stack>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
