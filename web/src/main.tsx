import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { buildTheme } from "./theme";
import { themeById } from "./themes";
import { usePreferences } from "./preferences";
import { router } from "./router";
import { PasswordGate } from "./PasswordGate";
import { ApiError } from "./api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retrying a refusal just delays the password dialog by three round trips:
      // a locked session and an unconfigured API are both answers, not blips.
      retry: (failureCount, error) =>
        error instanceof ApiError && (error.status === 401 || error.status === 503)
          ? false
          : failureCount < 3,
    },
  },
});

/**
 * The theme, and the browser chrome that has to agree with it.
 *
 * Outside `PasswordGate` on purpose: the login dialog and the "not configured"
 * screen are the *first* thing anyone sees, and a sign-in page in the wrong
 * theme is the one screen where a theme preference would look broken.
 *
 * `useMemo` on the id rather than the object: `usePreferences` returns an
 * identity-stable snapshot, but keying on the id says what actually decides the
 * theme, and rebuilding a MUI theme on every unrelated preference change would
 * remount every styled component in the app.
 */
function Themed({ children }: { children: React.ReactNode }) {
  const { themeId } = usePreferences();
  const spec = themeById(themeId);
  const theme = useMemo(() => buildTheme(spec), [spec]);

  // The two things CSS can't reach. `theme-color` paints the browser's own UI
  // (the Android address bar, the iOS status area, a PWA's title bar) and
  // `index.html` ships it hardcoded to the default theme's near-black; without
  // this, picking Light+ leaves a black bar over a white app. `colorScheme` on
  // the root element is what makes the native scrollbars and form controls
  // follow, and it is set here as well as in CssBaseline so it lands before the
  // first paint of a reload rather than after MUI's stylesheet is injected.
  useEffect(() => {
    document.documentElement.style.colorScheme = spec.mode;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", spec.chrome);
  }, [spec]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Themed>
      <QueryClientProvider client={queryClient}>
        {/* Inside the query client (it checks the session with a query), outside
            the router (a locked app has no pages). */}
        <PasswordGate>
          <RouterProvider router={router} />
        </PasswordGate>
      </QueryClientProvider>
    </Themed>
  </StrictMode>,
);
