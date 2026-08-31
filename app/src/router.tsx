import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type AnyRoute,
} from "@tanstack/react-router";
import { Layout } from "./components/layout/Layout";
import { AlertsPage } from "./components/pages/alerts/AlertsPage";
import { LibraryPage, DEFAULT_LIBRARY_TAB, LibraryPanel } from "./components/pages/library/LibraryPage";
import { RoutesPage } from "./components/pages/routes/RoutesPage";
import { validateRoutesSearch } from "./components/pages/routes/searchParams";
import { Tools, DEFAULT_TOOLS_TAB, ToolsPanel } from "./components/pages/tools/ToolsPage";

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RoutesPage,
  validateSearch: validateRoutesSearch,
});

// A section route whose bare path (`/library`, `/tools`) redirects to a
// default `$tab` child, so the section is never a blank pane — see
// `CLAUDE.md`'s "Both multi-tab pages' sections are ROUTES, not state". The
// redirect itself stays with each call site so `redirect({ to: ... })` keeps
// checking against the real, literal route path.
function tabbedSection<TParent extends AnyRoute>(
  parentRoute: TParent,
  redirectToDefaultTab: () => never,
  TabComponent: () => React.JSX.Element | null,
) {
  const indexRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/",
    beforeLoad: redirectToDefaultTab,
  });
  const tabRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "$tab",
    component: TabComponent,
  });
  return [indexRoute, tabRoute] as const;
}

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});
const libraryTabs = tabbedSection(
  libraryRoute,
  () => {
    throw redirect({ to: "/library/$tab", params: { tab: DEFAULT_LIBRARY_TAB }, replace: true });
  },
  LibraryPanel,
);

// The working surfaces over the seats.aero route graph. Split out of the
// Library, which is reference data — see `pages/tools/ToolsPage.tsx`.
const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: Tools,
});
const toolsTabs = tabbedSection(
  toolsRoute,
  () => {
    throw redirect({ to: "/tools/$tab", params: { tab: DEFAULT_TOOLS_TAB }, replace: true });
  },
  ToolsPanel,
);

// The scheduled sweep — the one page about work nobody triggered.
const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts",
  component: AlertsPage,
});

// Four pages. The Routes page is the single place stored finds are read:
// one surface over the finds query, rather than the Routes page and a database browser
// drifting apart about what a current find is.
const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute.addChildren(libraryTabs),
  toolsRoute.addChildren(toolsTabs),
  alertsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
