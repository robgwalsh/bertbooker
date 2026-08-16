import type { Alliance } from "../types.js";
import { PROGRAM_SEEDS } from "./programs.js";
// `AirlineInfo` is declared in `../wire/reference.ts` for the same reason
// `CurrencyInfo` is: `GET /api/airlines` answers `c.json(AIRLINE_DIRECTORY)`
// verbatim, so the wire type is the element type of that array.
import type { AirlineInfo } from "../wire/reference.js";

export type { AirlineInfo } from "../wire/reference.js";

/** A carrier you actually fly, as opposed to a loyalty program you pay with.
 *  The Library's Airlines section answers "which miles buy a seat on this
 *  metal", which is the alliance table plus a pile of bilateral deals. */
export interface AirlineSeed {
  /** IATA carrier code (2 chars), unique. */
  code: string;
  name: string;
  /** ISO 3166-1 alpha-2 of the carrier's home country (for the flag). */
  country: string;
  alliance: Alliance;
  /** Programs that can book this carrier BEYOND its alliance's programs:
   *  bilateral partnerships, plus the carrier's own program when it isn't in an
   *  alliance we model. Codes MUST exist in `PROGRAM_SEEDS` (pinned by a test).
   *  Alliance-mates are derived, never listed here. */
  partners: string[];
}

// NOTE: like PROGRAM_SEEDS, these are SEED DEFAULTS as of 2026-08 and reflect
// the long-stable relationships. Bilateral partnerships churn (Alaska/Emirates
// ended, SAS moved Star -> SkyTeam, Virgin Atlantic joined SkyTeam), so treat a
// row as "worth checking", not as a guarantee. Carriers no program we model can
// book (e.g. Southwest — Rapid Rewards isn't in PROGRAM_SEEDS) are deliberately
// absent rather than listed as unbookable; a test pins that every row resolves
// to at least one program.
export const AIRLINE_SEEDS: AirlineSeed[] = [
  // ---- Star Alliance (aeroplan / lifemiles / turkish / united / eva / ana / singapore) ----
  { code: "AC", name: "Air Canada", country: "CA", alliance: "star", partners: [] },
  { code: "UA", name: "United Airlines", country: "US", alliance: "star", partners: [] },
  { code: "LH", name: "Lufthansa", country: "DE", alliance: "star", partners: [] },
  { code: "LX", name: "Swiss", country: "CH", alliance: "star", partners: [] },
  { code: "OS", name: "Austrian Airlines", country: "AT", alliance: "star", partners: [] },
  { code: "SN", name: "Brussels Airlines", country: "BE", alliance: "star", partners: [] },
  { code: "TK", name: "Turkish Airlines", country: "TR", alliance: "star", partners: [] },
  // Alaska Mileage Plan and Virgin Flying Club both sell KrisFlyer metal.
  { code: "SQ", name: "Singapore Airlines", country: "SG", alliance: "star", partners: ["alaska", "virginatlantic"] },
  // The Virgin Atlantic -> ANA sweet spot: a non-alliance route into Star metal.
  { code: "NH", name: "ANA", country: "JP", alliance: "star", partners: ["virginatlantic"] },
  { code: "OZ", name: "Asiana Airlines", country: "KR", alliance: "star", partners: [] },
  { code: "AI", name: "Air India", country: "IN", alliance: "star", partners: [] },
  { code: "AV", name: "Avianca", country: "CO", alliance: "star", partners: [] },
  { code: "CM", name: "Copa Airlines", country: "PA", alliance: "star", partners: [] },
  { code: "BR", name: "EVA Air", country: "TW", alliance: "star", partners: [] },
  { code: "TP", name: "TAP Air Portugal", country: "PT", alliance: "star", partners: [] },
  { code: "TG", name: "Thai Airways", country: "TH", alliance: "star", partners: [] },
  { code: "ET", name: "Ethiopian Airlines", country: "ET", alliance: "star", partners: [] },
  { code: "MS", name: "EgyptAir", country: "EG", alliance: "star", partners: [] },
  { code: "LO", name: "LOT Polish Airlines", country: "PL", alliance: "star", partners: [] },
  { code: "A3", name: "Aegean Airlines", country: "GR", alliance: "star", partners: [] },
  { code: "NZ", name: "Air New Zealand", country: "NZ", alliance: "star", partners: [] },
  { code: "CA", name: "Air China", country: "CN", alliance: "star", partners: ["virginatlantic"] },

  // ---- oneworld (avios / aadvantage / alaska / cathay / qantas) ----
  { code: "AA", name: "American Airlines", country: "US", alliance: "oneworld", partners: [] },
  { code: "BA", name: "British Airways", country: "GB", alliance: "oneworld", partners: [] },
  { code: "IB", name: "Iberia", country: "ES", alliance: "oneworld", partners: [] },
  { code: "QR", name: "Qatar Airways", country: "QA", alliance: "oneworld", partners: ["jetblue"] },
  { code: "CX", name: "Cathay Pacific", country: "HK", alliance: "oneworld", partners: [] },
  { code: "JL", name: "Japan Airlines", country: "JP", alliance: "oneworld", partners: [] },
  { code: "AY", name: "Finnair", country: "FI", alliance: "oneworld", partners: [] },
  { code: "QF", name: "Qantas", country: "AU", alliance: "oneworld", partners: ["emirates"] },
  { code: "MH", name: "Malaysia Airlines", country: "MY", alliance: "oneworld", partners: [] },
  { code: "AS", name: "Alaska Airlines", country: "US", alliance: "oneworld", partners: [] },
  { code: "RJ", name: "Royal Jordanian", country: "JO", alliance: "oneworld", partners: [] },
  { code: "AT", name: "Royal Air Maroc", country: "MA", alliance: "oneworld", partners: [] },
  // IAG, but not a oneworld member since 2007 — Avios is the way in.
  { code: "EI", name: "Aer Lingus", country: "IE", alliance: null, partners: ["avios", "jetblue"] },

  // ---- SkyTeam (flyingblue) ----
  { code: "DL", name: "Delta Air Lines", country: "US", alliance: "skyteam", partners: ["virginatlantic"] },
  { code: "AF", name: "Air France", country: "FR", alliance: "skyteam", partners: ["virginatlantic"] },
  { code: "KL", name: "KLM", country: "NL", alliance: "skyteam", partners: ["virginatlantic"] },
  { code: "KE", name: "Korean Air", country: "KR", alliance: "skyteam", partners: ["alaska"] },
  // SkyTeam since 2023; its own Flying Club is the program we model.
  { code: "VS", name: "Virgin Atlantic", country: "GB", alliance: "skyteam", partners: ["virginatlantic"] },
  { code: "AM", name: "Aeroméxico", country: "MX", alliance: "skyteam", partners: [] },
  { code: "AZ", name: "ITA Airways", country: "IT", alliance: "skyteam", partners: ["virginatlantic"] },
  { code: "CI", name: "China Airlines", country: "TW", alliance: "skyteam", partners: [] },
  { code: "MU", name: "China Eastern", country: "CN", alliance: "skyteam", partners: ["qantas"] },
  { code: "VN", name: "Vietnam Airlines", country: "VN", alliance: "skyteam", partners: [] },
  { code: "GA", name: "Garuda Indonesia", country: "ID", alliance: "skyteam", partners: [] },
  { code: "SV", name: "Saudia", country: "SA", alliance: "skyteam", partners: [] },
  { code: "KQ", name: "Kenya Airways", country: "KE", alliance: "skyteam", partners: [] },
  // Left Star Alliance for SkyTeam in 2024 — Aeroplan/United no longer apply.
  { code: "SK", name: "SAS", country: "SE", alliance: "skyteam", partners: [] },

  // ---- No alliance ----
  { code: "EK", name: "Emirates", country: "AE", alliance: null, partners: ["emirates", "aeroplan", "qantas", "jetblue"] },
  { code: "EY", name: "Etihad Airways", country: "AE", alliance: null, partners: ["etihad", "aeroplan", "aadvantage"] },
  { code: "B6", name: "JetBlue", country: "US", alliance: null, partners: ["jetblue", "avios", "emirates", "etihad", "singapore"] },
  { code: "HA", name: "Hawaiian Airlines", country: "US", alliance: null, partners: ["alaska", "virginatlantic"] },
  { code: "VA", name: "Virgin Australia", country: "AU", alliance: null, partners: ["virginatlantic", "singapore", "united"] },
  { code: "FJ", name: "Fiji Airways", country: "FJ", alliance: null, partners: ["alaska", "qantas"] },
  { code: "JX", name: "Starlux Airlines", country: "TW", alliance: null, partners: ["alaska"] },
  { code: "DE", name: "Condor", country: "DE", alliance: null, partners: ["alaska"] },
];

/** Programs whose miles can book a seat on this carrier: its alliance's programs
 *  (derived from `PROGRAM_SEEDS`, so adding a program picks up every carrier in
 *  its alliance for free) plus the seed's bilateral partners. Returned in
 *  `PROGRAM_SEEDS` order so the UI's chip order is stable. Unknown code -> []. */
export function programsForAirline(code: string): string[] {
  const airline = AIRLINE_SEEDS.find((a) => a.code === code);
  if (!airline) return [];
  const extra = new Set(airline.partners);
  return PROGRAM_SEEDS.filter(
    (p) =>
      p.kind === "airline" &&
      ((airline.alliance !== null && p.alliance === airline.alliance) || extra.has(p.code)),
  ).map((p) => p.code);
}

export const AIRLINE_DIRECTORY: AirlineInfo[] = AIRLINE_SEEDS.map((a) => ({
  code: a.code,
  name: a.name,
  country: a.country,
  alliance: a.alliance,
  programs: programsForAirline(a.code),
}));
