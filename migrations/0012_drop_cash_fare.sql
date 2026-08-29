-- The cash fare is gone, and with it the second half of bookability.
--
-- A find could be "bookable" two ways: its program takes a currency the couple
-- holds, or its revenue fare is known and any card's travel portal can buy the
-- same seat. The second existed for one case — a program none of the held
-- currencies reached, Delta above all, whose SkyMiles take Amex and nothing
-- else. Amex is now one of those currencies, so the case it was built for is
-- gone and the machinery with it.
--
-- WHAT THIS COSTS: nothing measurable. No source has ever written these
-- columns. seats.aero returns no revenue fare (providers/seatsaero.ts), enrich
-- rewrites segments and never a price, and PointsYeah — the only other source
-- this app has had — lost every row to 0002. The feature was dormant
-- machinery over three all-NULL columns.
--
-- WHAT STAYS, and the distinction this migration must not blur:
-- `cash_fees_cents` and `fees_currency` on both tables are the residual TAX on
-- an award redemption, not a ticket price. They are quoted in the currency the
-- program charges — CAD for Aeroplan, KRW for Korean — which is why `money()`
-- exists in the app. They are untouched here. 0001 and 0009 are annotated in
-- place so a reader arriving at either column knows which one this was.
--
-- Safe as a plain column drop: no index, view, trigger, CHECK, foreign key or
-- generated column anywhere in migrations/ names any of the three. Verified
-- against 0001's five snapshot indexes and 0009's three.

ALTER TABLE availability_snapshots DROP COLUMN cash_price_cents;
ALTER TABLE availability_snapshots DROP COLUMN cash_price_currency;

-- price_history has no currency twin: only the fare rode along in the seed.
ALTER TABLE price_history DROP COLUMN cash_price_cents;
