import { Chip, Stack, Tooltip } from "@mui/material";
import { BookableCurrencies, CabinChip } from "../../components/brand";
import { parseCodeList } from "../../lib/routeShape";
import type { TrackedRoute } from "../../api";

/**
 * A route's stored filters as chips: which cabins it watches, and which cards it
 * will accept space for.
 *
 * Rail-only now — the detail header states the same two facts along its one
 * row. Freed of that second caller, these shrink: four of
 * them at full size was the tallest thing in a rail card and the least urgent.
 * `& .MuiChip-root` scales the shared `CabinChip` down here without touching how
 * it renders elsewhere; `BookableCurrencies` takes an explicit `size` instead,
 * since an icon has no label to shrink.
 */
export function RouteFilters({ route }: { route: TrackedRoute }) {
  const cabins = parseCodeList(route.cabins);
  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flexWrap: "wrap",
        alignItems: "center",
        "& .MuiChip-root": { height: 19, fontSize: 10.5 },
        "& .MuiChip-label": { px: 0.85 },
      }}
    >
      {cabins.length > 0 ? (
        cabins.map((c) => <CabinChip key={c} cabin={c} />)
      ) : (
        <Chip size="small" variant="outlined" label="Any cabin" />
      )}
      {parseCodeList(route.currencies).length > 0 && (
        <BookableCurrencies
          json={route.currencies ?? undefined}
          size={17}
          note="only showing space bookable with this"
        />
      )}
      {/* Same rule as the nonstop chip: only when it is on. Worth a chip at all
          because it is the one setting here that changed what was FETCHED, so
          two routes over the same pair can legitimately hold different data. */}
      {route.round_trip === 1 && (
        <Tooltip title="Both directions are searched for this route">
          <Chip size="small" variant="outlined" color="primary" label="Round trip" />
        </Tooltip>
      )}
      {/* Only when it is ON. An "any routing" chip on every unfiltered route
          would be four-fifths of the rail saying nothing. */}
      {Boolean(route.direct_only) && (
        <Tooltip title="Only nonstop finds are shown under this route">
          <Chip size="small" variant="outlined" color="info" label="Nonstop" />
        </Tooltip>
      )}
    </Stack>
  );
}
