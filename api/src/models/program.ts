// WHAT THE COUPLE CAN PAY WITH, and what each loyalty program takes. Seed data
// and the one lookup over it: `currenciesForProgram` is the inverse index of
// `transferPartners`, and belongs beside the array it reads rather than in a
// util, because it is only meaningful about THIS array.
//
// `seed/programs.sql` mirrors `PROGRAM_SEEDS` — keep them in step when adding or
// editing a program. The seed lives outside `migrations/` so it stays
// re-runnable, and `sources/registry.ts` validates every program a source
// declares against this array at boot.
import type { Alliance, Currency } from "./availability.js";
// `CurrencyInfo` is declared in `shared/src/wire/reference.ts`, because
// `GET /api/currencies` answers `c.json(CURRENCIES)` verbatim — the wire type IS
// the element type of `CURRENCIES` below, and annotating that array against it
// is what keeps the served shape and the declared one in step.
import type { CurrencyInfo } from "../../../shared/src/wire/reference.js";

export type { CurrencyInfo } from "../../../shared/src/wire/reference.js";

export interface TransferPartner {
  currency: Currency;
  /** Transfer ratio, points-out : miles-in, e.g. "1:1", "2:1.5". */
  ratio: string;
}

/** A program is an airline's or a hotel's. Nothing SEARCHES a hotel program —
 *  the Library page is what renders them. */
export type ProgramKind = "airline" | "hotel";

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
// Citi ThankYou, Amex Membership Rewards, plus "direct" for miles held
// in-program.

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

/**
 * Every program the app knows how to name, and what can transfer into it.
 *
 * **`seed/programs.sql` mirrors this array — keep the two in sync** when adding
 * or editing a program. The seed is what actually fills the `programs` table
 * (idempotent `INSERT OR REPLACE`, re-runnable, and deliberately outside
 * `migrations/` for that reason); this array is what the providers read, because
 * they have no DB access. Adding a program here and not there gives you a code
 * that filters correctly in the Worker and renders as unknown in the app.
 *
 * A third reader makes the drift loud rather than silent in one direction:
 * `registerSource` validates every program a source declares against this array
 * at module scope, so a typo here fails the worker's boot instead of a write
 * mid-search. Nothing checks it against the seed.
 */
export const PROGRAM_SEEDS: ProgramSeed[] = [
  // ---- Star Alliance ----
  {
    code: "aeroplan",
    name: "Air Canada Aeroplan",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
  },
  {
    code: "lifemiles",
    name: "Avianca LifeMiles",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
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
    // Amex is the only one of the couple's currencies that transfers to ANA;
    // the others reach it only through Virgin Atlantic or United partner
    // bookings, which is not a transfer and is not modeled here.
    transferPartners: [p("amex_mr")],
  },
  {
    code: "singapore",
    name: "Singapore KrisFlyer",
    kind: "airline",
    alliance: "star",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
  },
  // ---- SkyTeam / partners ----
  {
    code: "flyingblue",
    name: "Air France/KLM Flying Blue",
    kind: "airline",
    alliance: "skyteam",
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
  },
  {
    code: "skymiles",
    name: "Delta SkyMiles",
    kind: "airline",
    alliance: "skyteam",
    // Amex only. Delta takes no other transfer partner, so a SkyMiles award is
    // bookable with Membership Rewards or not at all.
    transferPartners: [p("amex_mr")],
  },
  {
    code: "virginatlantic",
    name: "Virgin Atlantic Flying Club",
    kind: "airline",
    alliance: null,
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
  },
  {
    code: "aeromexico",
    name: "Aeroméxico Rewards",
    kind: "airline",
    alliance: "skyteam",
    // Renamed from Club Premier; seats.aero and most guides still use the old
    // name. Capital One and Citi both transfer 1:1 — verified 2026-08-09 against
    // Capital One's published partner list and two independent roundups, because
    // one aggregator's table omitted Capital One entirely. Amex is the one
    // partner that pays out more than it takes in. Chase and Bilt do NOT
    // transfer.
    transferPartners: [p("capital_one"), p("citi_ty"), p("amex_mr", "1:1.6")],
  },
  // ---- oneworld ----
  {
    code: "avios",
    name: "Avios (BA / Iberia / Aer Lingus / Qatar / Finnair)",
    kind: "airline",
    alliance: "oneworld",
    // One code covers five programs, and Amex is the partner that does not
    // reach all of them: BA, Iberia, Aer Lingus and Qatar take Membership
    // Rewards, Finnair does not.
    transferPartners: [p("chase_ur"), p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
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
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr", "5:4")],
  },
  {
    code: "jetblue",
    name: "JetBlue TrueBlue",
    kind: "airline",
    alliance: null,
    transferPartners: [p("chase_ur"), p("citi_ty"), p("amex_mr", "5:4")],
  },
  {
    code: "qantas",
    name: "Qantas Frequent Flyer",
    kind: "airline",
    alliance: "oneworld",
    transferPartners: [p("capital_one"), p("bilt"), p("citi_ty"), p("amex_mr")],
  },
  // ---- Gulf / other ----
  {
    code: "emirates",
    name: "Emirates Skywards",
    kind: "airline",
    alliance: null,
    transferPartners: [
      p("chase_ur"),
      p("capital_one"),
      p("bilt"),
      p("citi_ty"),
      p("amex_mr", "5:4"),
    ],
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
    transferPartners: [p("bilt"), p("amex_mr")],
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
    transferPartners: [p("citi_ty"), p("capital_one"), p("amex_mr")],
  },
];

/** Currencies the couple holds, for the balances UI. */
export const CURRENCIES: CurrencyInfo[] = [
  { code: "chase_ur", name: "Chase Ultimate Rewards" },
  { code: "capital_one", name: "Capital One Miles" },
  { code: "bilt", name: "Bilt Rewards" },
  { code: "citi_ty", name: "Citi ThankYou" },
  { code: "amex_mr", name: "Amex Membership Rewards" },
  { code: "direct", name: "Airline/hotel miles (direct)" },
];
