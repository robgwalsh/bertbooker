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
import { api } from "../../../api";
import type { PairReach, RouteReach } from "../../../api";
import { VerdictChip } from "./chips";

/**
 * Do the routes you track go anywhere anyone is watching?
 *
 * A tracked pair in no program's network will come back empty from every search,
 * forever, and nothing else in the app says so — an empty result looks the same
 * whether the space is gone or was never monitored. That is the whole value
 * here, and it is only answerable because the cache spans programs.
 *
 * **This is not `search_coverage`.** That table records whether WE looked. This
 * records whether the SOURCE flies it at all, which is true or false before
 * anyone searches anything.
 */
export function ReachPanel() {
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

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {data.fetchedSources
          ? `Checked against ${data.fetchedSources} of ${data.totalSources} sources fetched so far.`
          : "Nothing has been fetched yet, so every route reads Unknown. Fetch a program above."}
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
 * The pairs that failed, named.
 *
 * A route's verdict is its WORST pair's, so "Gap" on a four-pair route says
 * nothing about WHICH leg is the problem — and that is the only actionable part.
 * A percentage would hide exactly this.
 */
function RouteDetail({ route }: { route: RouteReach }) {
  if (route.verdict === "unknown") return null;

  const gaps = route.pairs.filter((p) => p.verdict === "gap");
  if (gaps.length) {
    return (
      <Typography variant="caption" color="warning.main">
        no program flies {gaps.map(pairLabel).join(", ")}
      </Typography>
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
