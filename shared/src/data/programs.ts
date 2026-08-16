import type { Alliance, Currency, ProgramKind } from "../types.js";
// `CurrencyInfo` is declared in `../wire/reference.ts`, because
// `GET /api/currencies` answers `c.json(CURRENCIES)` verbatim — the wire type IS
// the element type of `CURRENCIES` below, and annotating that array against it
// is what keeps the served shape and the declared one in step.
import type { CurrencyInfo } from "../wire/reference.js";

export type { CurrencyInfo } from "../wire/reference.js";

export interface TransferPartner {
  currency: Currency;
  /** Transfer ratio, points-out : miles-in, e.g. "1:1", "2:1.5". */
  ratio: string;
}

export interface ProgramSeed {
  code: string;
  name: string;
  kind: ProgramKind;
  alliance: Alliance;
  /** Which of the couple's currencies can feed this program. May be empty
   *  (e.g. ANA — reachable only via partner award bookings, not a direct
   *  transfer from a currency she holds). */
  transferPartners: TransferPartner[];
}

// NOTE: transfer relationships/ratios are SEED DEFAULTS reflecting the common,
// long-stable 1:1 partnerships as of 2026-08. Programs change these; the app
// stores them in the editable `programs` D1 table so they can be corrected
// without a code change. Currencies modeled: Chase UR, Capital One, Bilt,
// Citi ThankYou, plus "direct" for miles held in-program. (No Amex.)

const p = (currency: Currency, ratio = "1:1"): TransferPartner => ({ currency, ratio });

/** Which of the couple's currencies can book this program — i.e. the
 *  `bookableWith` for a result from a single-program source (an airline's own
 *  site), which has no `transfer[]` array of its own to derive it from.
 *
 *  Seed-derived. The editable `programs` D1 table is the runtime truth, but
 *  providers have no DB access, so this is the best available approximation.
 *  Deliberately excludes "direct": including it would mark every single-program
 *  result bookable regardless of actual balances. */
export function currenciesForProgram(code: string): Currency[] {
  return PROGRAM_SEEDS.find((s) => s.code === code)?.transferPartners.map((t) => t.currency) ?? [];
}

export const PROGRAM_SEEDS: ProgramSeed[] = [
  // ---- Star Alliance ----
  {
    code: "aeroplan",
    name: "Air Canada Aeroplan",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "lifemiles",
    name: "Avianca LifeMiles",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "turkish",
    name: "Turkish Miles&Smiles",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "united",
    name: "United MileagePlus",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("chase_ur"), p("bilt")],
  },
  {
    code: "eva",
    name: "EVA Air Infinity MileageLands",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("citi_ty")],
  },
  {
    code: "ana",
    name: "ANA Mileage Club",
    kind: "airline",
    alliance: "star",
    // Reachable via Virgin Atlantic / United partner bookings, not a direct
    // transfer from her currencies — kept searchable, no direct partners.
    transferPartners: [],
  },
  {
    code: "singapore",
    name: "Singapore KrisFlyer",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  // ---- SkyTeam / partners ----
  {
    code: "flyingblue",
    name: "Air France/KLM Flying Blue",
    kind: "airline",
    alliance: "skyteam",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "skymiles",
    name: "Delta SkyMiles",
    kind: "airline",
    alliance: "skyteam",
    // None. Delta transfers only from Amex, which the couple deliberately does
    // not hold — so a SkyMiles award is never bookable with their points and
    // `bookableWith` comes back empty by construction. That makes Delta the
    // clearest case for cash pricing: the only way one of these seats becomes
    // reachable is by buying the revenue fare through a card's travel portal.
    transferPartners: [],
  },
  {
    code: "virginatlantic",
    name: "Virgin Atlantic Flying Club",
    kind: "airline",
    alliance: null,
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "aeromexico",
    name: "Aeroméxico Rewards",
    kind: "airline",
    alliance: "skyteam",
    // Renamed from Club Premier; seats.aero and most guides still use the old
    // name. Capital One and Citi both transfer 1:1 — verified 2026-08-09 against
    // Capital One's published partner list and two independent roundups, because
    // one aggregator's table omitted Capital One entirely. Amex transfers at
    // 1:1.6 and is deliberately not modeled. Chase and Bilt do NOT transfer.
    transferPartners: [p("capital_one"), p("citi_ty")],
  },
  // ---- oneworld ----
  {
    code: "avios",
    name: "Avios (BA / Iberia / Aer Lingus / Qatar / Finnair)",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "aadvantage",
    name: "American AAdvantage",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("bilt")],
  },
  {
    code: "alaska",
    name: "Alaska Mileage Plan",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("bilt")],
  },
  {
    code: "cathay",
    name: "Cathay Pacific Asia Miles",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "jetblue",
    name: "JetBlue TrueBlue",
    kind: "airline",
    alliance: null,
    transferPartners: [p("chase_ur"), p("citi_ty")],
  },
  {
    code: "qantas",
    name: "Qantas Frequent Flyer",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty")],
  },
  // ---- Gulf / other ----
  {
    code: "emirates",
    name: "Emirates Skywards",
    kind: "airline",
    alliance: null,
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty")],
  },
  {
    code: "etihad",
    name: "Etihad Guest",
    kind: "airline",
    alliance: null,
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty")],
  },
  // ---- Hotels ----
  {
    code: "hyatt",
    name: "World of Hyatt",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("chase_ur"), p("bilt")],
  },
  {
    code: "marriott",
    name: "Marriott Bonvoy",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("bilt")],
  },
  {
    code: "ihg",
    name: "IHG One Rewards",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("chase_ur"), p("bilt")],
  },
  {
    code: "accor",
    name: "Accor Live Limitless",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("capital_one", "2:1"), p("citi_ty", "2:1")],
  },
  {
    code: "wyndham",
    name: "Wyndham Rewards",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("citi_ty")],
  },
  {
    code: "choice",
    name: "Choice Privileges",
    kind: "hotel",
    alliance: null,
    transferPartners: [p("citi_ty"), p("capital_one")],
  },
];

/** Currencies the couple holds, for the balances UI. */
export const CURRENCIES: CurrencyInfo[] = [
  {
    code: "chase_ur",
    name: "Chase Ultimate Rewards",
    portalCentsPerPoint: 1.5, // Sapphire Reserve (Preferred/Ink Preferred are 1.25)
    portalName: "Chase Travel",
  },
  {
    code: "capital_one",
    name: "Capital One Miles",
    portalCentsPerPoint: 1.0, // Venture X, redeeming miles against a booking
    portalName: "Capital One Travel",
  },
  { code: "bilt", name: "Bilt Rewards", portalCentsPerPoint: 1.25, portalName: "Bilt Travel" },
  { code: "citi_ty", name: "Citi ThankYou", portalCentsPerPoint: 1.0, portalName: "Citi Travel" },
  // No portal: these are miles already sitting in an airline/hotel program.
  { code: "direct", name: "Airline/hotel miles (direct)" },
];

/** Currencies that can pay for a CASH fare through their own travel portal.
 *
 *  This is the "any means" half of bookability, and it is deliberately NOT the
 *  same question as `currenciesForProgram`. Chase doesn't transfer to Alaska
 *  Mileage Plan, so an Alaska award is unbookable with Chase points — but the
 *  same seat's revenue fare is buyable through Chase Travel. A result carrying a
 *  cash price is therefore reachable by every currency listed here, whatever its
 *  program's transfer partners are. */
export const PORTAL_CURRENCIES: Currency[] = CURRENCIES.filter(
  (c) => c.portalCentsPerPoint != null,
).map((c) => c.code);

/** How many points a cash fare costs through `currency`'s travel portal.
 *  Undefined when that currency has no portal, or the price is unknown.
 *  Rounded up — you can't pay a fraction of a point. Pure. */
export function pointsForCash(cents: number | undefined, currency: Currency): number | undefined {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return undefined;
  const rate = CURRENCIES.find((c) => c.code === currency)?.portalCentsPerPoint;
  if (!rate) return undefined;
  return Math.ceil(cents / rate);
}

/** The cheapest points price across the given currencies, for "what would this
 *  actually cost me". Returns the winning currency too, so the UI can name it.
 *  Pure. */
export function bestPointsForCash(
  cents: number | undefined,
  currencies: readonly Currency[],
): { currency: Currency; points: number } | undefined {
  let best: { currency: Currency; points: number } | undefined;
  for (const c of currencies) {
    const points = pointsForCash(cents, c);
    if (points != null && (!best || points < best.points)) best = { currency: c, points };
  }
  return best;
}
