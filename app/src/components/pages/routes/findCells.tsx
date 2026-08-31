import { Box, Tooltip, Typography } from "@mui/material";
import type { Find } from "../../../api";
import { itineraryLegs } from "./Itinerary";
import { money, miles, dollars } from "../../../lib/format";
import { Journey } from "../../../lib/multiLeg";
import { RoundTripPair } from "../../../lib/roundtrip";
import { CarrierSet } from "../../brand/CarrierSet";

// The cell BODIES that both layouts draw.
//
// `FindsTable` and `RoundTripTable` each render two ways now — a table on a
// desktop, a stack of cards on a phone — and these are the pieces where that
// would have cost something. Every one of them encodes a decision rather than a
// format: an award's tax quoted in the currency it is charged in, "never
// checked" told apart from "checked and empty", a round trip's total split by
// direction because the two halves are separate bookings.
//
// Extracted rather than written twice for the same reason `FindsTable` itself
// was extracted from the Routes page: a second copy does not stay a copy. The
// drift would be silent and it would be in the numbers.

/**
 * What a find costs.
 *
 * Miles first, then the award's own residual tax, then the nonstop's own price
 * when one exists and costs more, then how this price compares to the cheapest
 * the slot has ever been seen at.
 */
export function FindCost({ f }: { f: Find }) {
  // Its OWN currency, not assumed dollars: a KRW figure read as USD is off by
  // more than an order of magnitude, and it is a number people act on.
  const fees = f.cash_fees_cents > 0 ? `+ ${money(f.cash_fees_cents, f.fees_currency)}` : "";

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
      {/* `miles_cost` quotes the cheapest itinerary of ANY shape, so a
          connection is what it usually names. This is the premium for skipping
          the connection, which is a decision rather than a detail — and it
          arrives with the search at no extra call. Drawn only when it is dearer:
          equal figures would just say the cheapest award is already nonstop,
          which the itinerary beside it already shows. */}
      {f.direct_miles_cost != null && f.direct_miles_cost > f.miles_cost && (
        <Tooltip title="What the nonstop costs. The price above is the cheapest itinerary of any shape, which on this route is a connection.">
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", fontVariantNumeric: "tabular-nums", cursor: "help" }}
          >
            nonstop {miles(f.direct_miles_cost)}
          </Typography>
        </Tooltip>
      )}
    </>
  );
}

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

/**
 * A journey's total, split by leg.
 *
 * `TripTotalCost` for a connection rather than a round trip, and the split
 * carries more weight here: a round trip's two halves are separate bookings
 * weeks apart, while these are separate bookings hours apart, in as many
 * programs as the journey has legs. Which leg carries the total is what decides
 * whether the connection is worth the risk at all.
 *
 * Legs are named by their pair, not "Out"/"Back" — there is no home direction in
 * a one-way journey, and by the third leg an ordinal would say less than the
 * airports do.
 */
export function JourneyTotalCost({ j }: { j: Journey }) {
  return (
    <Tooltip
      title={
        j.mixed
          ? "The sum of separate one-way awards in DIFFERENT programs — two bookings, two currencies, and no single ticket that can ever cover both."
          : "seats.aero prices one-ways. This is the sum of separate one-way awards, booked separately — there is no through fare here."
      }
    >
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {miles(j.totalMiles)}
        </Typography>
        {j.legs.map(({ find: f }) => (
          <Typography
            key={`${f.origin}${f.destination}${f.flight_date}`}
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", fontVariantNumeric: "tabular-nums" }}
          >
            {/* The leg's far end only. Naming both would repeat the hub on every
                line and widen the column past the pane — the whole chain is one
                cell to the left, and the map beside it. */}
            →{f.destination} {miles(f.miles_cost)}
          </Typography>
        ))}
        {/* A total ONLY when every leg's taxes are charged in the same currency.
            They routinely are not — seats.aero quotes Aeroplan in CAD and Korean
            Air out of Seoul in KRW — and adding 560 USD cents to 2,400,000 KRW
            produces a number with no meaning, which as dollars reads as
            $24,029.90 for about $1,700 of tax. Mixed, the legs speak for
            themselves. */}
        {j.feesCurrency
          ? j.totalFeesCents > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                + {money(j.totalFeesCents, j.feesCurrency)}
              </Typography>
            )
          : j.legs
              .filter(({ find: f }) => f.cash_fees_cents > 0)
              .map(({ find: f }) => (
                <Typography
                  key={`fee-${f.origin}${f.destination}${f.flight_date}`}
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block" }}
                >
                  + {money(f.cash_fees_cents, f.fees_currency)}
                </Typography>
              ))}
      </Box>
    </Tooltip>
  );
}

/**
 * Which program books this, and who else sells the same cabin.
 *
 * The carrier marks are HERE rather than under the itinerary they describe,
 * because this column is `verticalAlign: top` beside a cell that is already as
 * tall as a drawn itinerary — so they cost no row height, where under the stop
 * bar they added a line to every row of every table.
 *
 * Carriers already named by the legs are omitted: those are drawn one column to
 * the left on the same row, and what is left is the competition — the reason to
 * re-search rather than book this one. A summary row has no legs, so it shows
 * the whole set, which is the only routing information such a row carries.
 */
export function FindProgram({ f }: { f: Find }) {
  return (
    <>
      <Typography variant="body2">{f.program}</Typography>
      <Box sx={{ mt: 0.5 }}>
        <CarrierSet
          airlines={f.airlines}
          directAirlines={f.direct_airlines}
          omit={itineraryLegs(f).map((l) => l.carrier)}
        />
      </Box>
    </>
  );
}
