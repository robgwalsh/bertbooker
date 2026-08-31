import { Stack, Box, alpha, Typography, Tooltip, useTheme } from "@mui/material";
import { AirlineLogo } from "./AirlineLogo";

/**
 * Which carriers compete for this cabin, as their marks.
 *
 * Takes the two raw blobs rather than a parsed list, the same way
 * `BookableCurrencies` does and for the same reason: every caller has them in
 * that form, and a malformed one renders nothing rather than throwing.
 *
 * The nonstop operators are told apart by a RING, not by order alone —
 * `carrierMarks` already puts them first, but on a row of five identical tiles
 * "the first two" is not something anyone can see. The tooltip names the
 * distinction, since a two-letter code says little on its own.
 */
export function CarrierSet({
  airlines,
  directAirlines,
  omit,
  size = 16,
  max = 6,
}: {
  airlines?: string | null;
  directAirlines?: string | null;
  omit?: Iterable<string>;
  size?: number;
  max?: number;
}) {
  const theme = useTheme();
  const marks = carrierMarks(airlines, directAirlines, omit);
  if (marks.length === 0) return null;

  const shown = marks.slice(0, max);
  const rest = marks.length - shown.length;

  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {shown.map((m) => (
        <Tooltip key={m.code} title={m.nonstop ? `${m.code} — flies this nonstop` : m.code}>
          <Box
            sx={{
              display: "inline-flex",
              borderRadius: 0.75,
              // Drawn OUTSIDE the tile so the logo keeps its own square: an
              // inset ring would eat into a 16px mark until it stopped reading
              // as a logo at all.
              boxShadow: m.nonstop
                ? `0 0 0 2px ${alpha(theme.palette.success.main, 0.9)}`
                : "none",
            }}
          >
            <AirlineLogo code={m.code} size={size} />
          </Box>
        </Tooltip>
      ))}
      {rest > 0 && (
        <Typography variant="caption" color="text.secondary">
          +{rest}
        </Typography>
      )}
    </Stack>
  );
}

/** A carrier serving a find's cabin, and whether it is one of the ones flying
 *  it nonstop. */
export interface CarrierMark {
  code: string;
  nonstop: boolean;
}

/**
 * Every carrier competing for a find's cabin, nonstop operators first.
 *
 * `direct_airlines` is documented as a SUBSET of `airlines`
 * (`api/src/providers/seatsaero.ts`), and is one in every captured fixture. This
 * unions them anyway: the blobs are two independent columns, the union costs a
 * `Set`, and it degrades to the same answer when the subset property holds. A
 * filter would silently drop a nonstop carrier if it ever did not.
 *
 * Nonstop first because that is the ordering somebody scanning for "can I avoid
 * the connection" is reading for; alphabetical within each half so a row's marks
 * don't reshuffle between searches.
 *
 * `omit` drops carriers the caller already shows some other way — a drawn
 * itinerary names its own operators leg by leg, so repeating them below it says
 * nothing, and what is left is exactly the competition the card cannot show.
 */
function carrierMarks(
  airlines?: string | null,
  directAirlines?: string | null,
  omit?: Iterable<string>,
): CarrierMark[] {
  const direct = new Set(parseCarriers(directAirlines));
  const all = new Set([...parseCarriers(airlines), ...direct]);
  for (const c of omit ?? []) all.delete(c);
  const sorted = [...all].sort();
  return [
    ...sorted.filter((c) => direct.has(c)).map((code) => ({ code, nonstop: true })),
    ...sorted.filter((c) => !direct.has(c)).map((code) => ({ code, nonstop: false })),
  ];
}


/** Parse one of the stored carrier blobs (`airlines`, `direct_airlines`)
 *  defensively (never throws). */
function parseCarriers(json?: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}
