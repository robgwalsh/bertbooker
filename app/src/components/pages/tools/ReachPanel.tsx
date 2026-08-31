import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import { api } from "../../../api/index";
import type { PairReach, RouteReach } from "../../../api/index";
import { SectionHeader } from "../../SectionHeader";
import { VerdictChip } from "./chips";

/**
 * Do the routes you track go anywhere anyone is watching?
 *
 * A tracked pair in no program's network will come back empty from every search,
 * forever, and nothing else in the app says so — an empty result looks the same
 * whether the space is gone or was never monitored. That is the whole value
 * here, and it is only answerable because the cache spans programs.
 *
 * **This is not coverage.** Coverage records whether WE looked. This records
 * whether the SOURCE flies it at all, which is true or false before anyone
 * searches anything.
 */
export function ReachPanel() {
  return (
    <Box>
      <SectionHeader
        title="Validate Routes"
        icon={<PublicRoundedIcon sx={{ color: "secondary.main" }} />}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Validates that your tracked routes are covered by seats.aero data.
      </Typography>
      <ReachBody />
    </Box>
  );
}

/** The report itself. Split from the header above so that every one of its
 *  early returns — loading, failed, no routes — still renders under the
 *  section's title rather than replacing the whole pane with a bare spinner. */
function ReachBody() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["route-graph", "reach"],
    queryFn: api.routeGraphReach,
  });

  if (isLoading)
    return (
      <Stack sx={{ py: 6, alignItems: "center" }}>
        <CircularProgress />
      </Stack>
    );
  if (error) return <Alert severity="error">Failed to load: {String(error)}</Alert>;
  if (!data) return null;

  if (!data.routes.length)
    return (
      <Typography variant="body2" color="text.secondary">
        No tracked flight routes yet.
      </Typography>
    );

  // The two-stop sweep is capped, and a capped sweep that says nothing about its
  // cap reads as an exhaustive one.
  const skipped = data.routes.reduce(
    (n, route) => n + route.pairs.filter((p) => p.deepCheckSkipped).length,
    0,
  );

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {data.fetchedSources
          ? `Checked against ${data.fetchedSources} of ${data.totalSources} sources fetched so far.`
          : "Nothing has been fetched yet, so every route reads Unknown. Fetch a program on the Data coverage tab."}
        {skipped
          ? ` ${skipped} ${skipped === 1 ? "pair was" : "pairs were"} searched to one stop only — ${data.deepPairLimit} pairs per sweep get the two-stop search.`
          : ""}
      </Typography>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Route</TableCell>
            <TableCell>Reach</TableCell>
            <TableCell sx={{ display: { xs: "none", sm: "table-cell" } }}>Pairs</TableCell>
            <TableCell>Programs</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.routes.map((route) => (
            <TableRow key={route.routeId}>
              <TableCell>
                <Typography variant="body2">
                  {route.origin} → {route.destination}
                  {route.roundTrip ? " ⇄" : ""}
                </Typography>
              </TableCell>
              <TableCell>
                <VerdictChip verdict={route.verdict} />
              </TableCell>
              <TableCell sx={{ display: { xs: "none", sm: "table-cell" } }}>
                <Typography variant="caption" color="text.secondary">
                  {route.pairs.length}
                </Typography>
              </TableCell>
              <TableCell>
                <RouteDetail route={route} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

/**
 * The pairs that failed, named — and the ones that only fail as written.
 *
 * A route's verdict is its WORST pair's, so "Gap" on a four-pair route says
 * nothing about WHICH leg is the problem — and that is the only actionable part.
 * A percentage would hide exactly this.
 *
 * An `indirect` pair names its hubs rather than its programs, because the hub is
 * the actionable half: the route as written will still return nothing, and what
 * to do about it is track the legs. `Who flies this pair?` has the full list.
 */
function RouteDetail({ route }: { route: RouteReach }) {
  if (route.verdict === "unknown") return null;

  const gaps = route.pairs.filter((p) => p.verdict === "gap");
  const indirect = route.pairs.filter((p) => p.verdict === "indirect");

  if (gaps.length || indirect.length) {
    return (
      <Stack spacing={0.25}>
        {gaps.length ? (
          <Typography variant="caption" color="warning.main">
            nothing reaches {gaps.map(pairLabel).join(", ")}
            {/* "We stopped looking" is not "there is nothing there", and a pair
                the budget skipped must not read as an exhausted one. */}
            {gaps.some((p) => p.deepCheckSkipped) ? " (not searched past one stop)" : ""}
          </Typography>
        ) : null}
        {indirect.map((p) => (
          <Typography key={pairLabel(p)} variant="caption" color="secondary.main" component="div">
            {pairLabel(p)} — {viaLabel(p)}
          </Typography>
        ))}
      </Stack>
    );
  }

  const programs = [...new Set(route.pairs.flatMap((p) => p.programs))].sort();
  const unmapped = [...new Set(route.pairs.flatMap((p) => p.unmappedSources))].sort();

  return (
    <Typography variant="caption" color="text.secondary">
      {programs.length ? programs.join(", ") : "—"}
      {/* Real reach this app cannot book. Named rather than dropped: it is the
          difference between "no award space exists" and "none you can reach". */}
      {unmapped.length ? ` (+${unmapped.length} not bookable from here)` : ""}
    </Typography>
  );
}

const pairLabel = (p: PairReach): string => `${p.origin}→${p.destination}`;

/** "1 stop via ICN, DEL, HKG". The stop count comes off the paths themselves —
 *  every path for a pair is at the depth the ladder stopped at, so the first
 *  one speaks for all of them. */
function viaLabel(pair: PairReach): string {
  const stops = pair.paths[0]?.via.length ?? 1;
  const hubs = [...new Set(pair.paths.map((path) => path.via.join("–")))];
  return `${stops} stop${stops === 1 ? "" : "s"} via ${hubs.join(", ")}`;
}
