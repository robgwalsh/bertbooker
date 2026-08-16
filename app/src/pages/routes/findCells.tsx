import { useQuery } from "@tanstack/react-query";
import { Box, Tooltip, Typography } from "@mui/material";
import { api, type Find } from "../../api";
import type { RoundTripPair } from "../../lib/roundtrip";
import { bestPortalPrice } from "../../lib/booking";
import { CURRENCY_LABEL } from "../../lib/currencies";
import { dollars, miles } from "../../lib/format";

// The cell BODIES that both layouts draw.
//
// `FindsTable` and `RoundTripTable` each render two ways now — a table on a
// desktop, a stack of cards on a phone — and these are the pieces where that
// would have cost something. Every one of them encodes a decision rather than a
// format: cash quoted beside miles and never ranked against it, "never checked"
// told apart from "checked and empty", a round trip's total split by direction
// because the two halves are separate bookings.
//
// Extracted rather than written twice for the same reason `FindsTable` itself
// was extracted from the Routes page: a second copy does not stay a copy. The
// drift would be silent and it would be in the numbers.

/**
 * What a find costs, in both currencies it can be paid in.
 *
 * Miles first, then fees, then — only when a cash fare is known — the same seat
 * priced through a card portal. **Shown side by side and never ranked:** "16,802
 * Chase" and "27,500 Alaska miles" are different currencies, and calling either
 * one cheaper needs a points valuation this app deliberately does not model.
 */
export function FindCost({ f }: { f: Find }) {
  const fees = f.cash_fees_cents > 0 ? `+ ${dollars(f.cash_fees_cents)}` : "";

  // Shared cache key with the Library tab, so this is one fetch for the whole
  // table however many rows or cards render.
  const currenciesQ = useQuery({ queryKey: ["currencies"], queryFn: api.currencies });
  const portal = bestPortalPrice(f.cash_price_cents, currenciesQ.data);
  const portalRate = currenciesQ.data?.find((c) => c.code === portal?.code);

  return (
    <>
      <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {miles(f.miles_cost)}
      </Typography>
      {fees && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {fees}
        </Typography>
      )}
      {portal && (
        <Tooltip
          title={`${dollars(f.cash_price_cents!)} cash, paid with ${
            portalRate?.portalName ?? CURRENCY_LABEL[portal.code] ?? portal.code
          } at ${portalRate?.portalCentsPerPoint}¢/pt`}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", fontVariantNumeric: "tabular-nums", cursor: "help" }}
          >
            or {portal.points.toLocaleString()} {CURRENCY_LABEL[portal.code] ?? portal.code}
          </Typography>
        </Tooltip>
      )}
    </>
  );
}

// `FindProvenance` was here — the source that wrote a row, over how long ago
// anybody checked that slot. It went with the Source / checked column
// (`FindsTable`), which went with the database browser. Its one real idea was
// that "never checked" and "checked, found nothing" are different answers and
// must not render alike; if that column ever comes back, that is the part to
// bring with it. `last_checked_at` is still on every `Find`.

/**
 * A round trip's total, split by direction.
 *
 * The split is not decoration. seats.aero prices one-ways, so this is the sum of
 * two separate awards booked separately — and which half is carrying the total
 * is exactly what decides whether re-searching one direction is worth anything.
 */
export function TripTotalCost({ p }: { p: RoundTripPair }) {
  return (
    <Tooltip title="seats.aero prices one-ways. This is the sum of two separate one-way awards, booked separately — there is no round-trip fare here.">
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {miles(p.totalMiles)}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", fontVariantNumeric: "tabular-nums" }}
        >
          Out {miles(p.outbound.miles_cost)}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", fontVariantNumeric: "tabular-nums" }}
        >
          Back {miles(p.inbound.miles_cost)}
        </Typography>
        {p.totalFeesCents > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            + {dollars(p.totalFeesCents)}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
}
