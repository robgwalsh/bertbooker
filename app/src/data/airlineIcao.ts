/**
 * IATA carrier code -> ICAO carrier code.
 *
 * HAND-MAINTAINED, unlike `worldGeometry.ts` beside it — there is no generator
 * and nothing to re-run. Add a row when a carrier's FlightAware link is wrong.
 *
 * It exists for exactly one caller: `flightAwareUrl` in `ui.tsx`. FlightAware
 * canonicalizes on the ICAO ident, so Delta's DL5678 is *its* DAL5678, and the
 * IATA form either 404s or — worse — lands on whichever carrier FlightAware
 * guesses from a two-letter prefix. The three-letter code is unambiguous.
 *
 * Keyed by IATA because that is what the sources speak: seats.aero, like every
 * source this app has carried, puts a two-character code in `Segment.carrier`.
 *
 * The first block covers `AIRLINE_SEEDS` in `api/src/domain/airlines.ts` (the carriers the Library
 * knows); the second is the operators that show up *inside* an itinerary without
 * being award carriers in their own right — US regionals flying a mainline
 * number, and low-cost carriers a cash fare can surface.
 */
export const AIRLINE_ICAO: Record<string, string> = {
  // ---- mirrors AIRLINE_SEEDS (api/src/domain/airlines.ts) ----
  AC: "ACA", // Air Canada
  UA: "UAL", // United Airlines
  LH: "DLH", // Lufthansa
  LX: "SWR", // Swiss
  OS: "AUA", // Austrian Airlines
  SN: "BEL", // Brussels Airlines
  TK: "THY", // Turkish Airlines
  SQ: "SIA", // Singapore Airlines
  NH: "ANA", // ANA
  OZ: "AAR", // Asiana Airlines
  AI: "AIC", // Air India
  AV: "AVA", // Avianca
  CM: "CMP", // Copa Airlines
  BR: "EVA", // EVA Air
  TP: "TAP", // TAP Air Portugal
  TG: "THA", // Thai Airways
  ET: "ETH", // Ethiopian Airlines
  MS: "MSR", // EgyptAir
  LO: "LOT", // LOT Polish Airlines
  A3: "AEE", // Aegean Airlines
  NZ: "ANZ", // Air New Zealand
  CA: "CCA", // Air China
  AA: "AAL", // American Airlines
  BA: "BAW", // British Airways
  IB: "IBE", // Iberia
  QR: "QTR", // Qatar Airways
  CX: "CPA", // Cathay Pacific
  JL: "JAL", // Japan Airlines
  AY: "FIN", // Finnair
  QF: "QFA", // Qantas
  MH: "MAS", // Malaysia Airlines
  AS: "ASA", // Alaska Airlines
  RJ: "RJA", // Royal Jordanian
  AT: "RAM", // Royal Air Maroc
  EI: "EIN", // Aer Lingus
  DL: "DAL", // Delta Air Lines
  AF: "AFR", // Air France
  KL: "KLM", // KLM
  KE: "KAL", // Korean Air
  VS: "VIR", // Virgin Atlantic
  AM: "AMX", // Aeroméxico
  AZ: "ITY", // ITA Airways — NOT Alitalia's old AZA, which FlightAware retired
  CI: "CAL", // China Airlines
  MU: "CES", // China Eastern
  VN: "HVN", // Vietnam Airlines
  GA: "GIA", // Garuda Indonesia
  SV: "SVA", // Saudia
  KQ: "KQA", // Kenya Airways
  SK: "SAS", // SAS
  EK: "UAE", // Emirates
  EY: "ETD", // Etihad Airways
  B6: "JBU", // JetBlue
  HA: "HAL", // Hawaiian Airlines
  VA: "VOZ", // Virgin Australia
  FJ: "FJI", // Fiji Airways
  JX: "SJX", // Starlux Airlines
  DE: "CFG", // Condor

  // ---- operators seen inside itineraries, not in AIRLINE_SEEDS ----
  WN: "SWA", // Southwest
  NK: "NKS", // Spirit
  F9: "FFT", // Frontier
  G4: "AAY", // Allegiant
  SY: "SCX", // Sun Country
  WS: "WJA", // WestJet
  OO: "SKW", // SkyWest
  YX: "RPA", // Republic Airways
  MQ: "ENY", // Envoy Air
  OH: "JIA", // PSA Airlines
  "9E": "EDV", // Endeavor Air
  YV: "ASH", // Mesa Airlines
  ZW: "AWI", // Air Wisconsin
  QX: "QXE", // Horizon Air
  LA: "LAN", // LATAM
  UX: "AEA", // Air Europa
  WY: "OMA", // Oman Air
  GF: "GFA", // Gulf Air
  PR: "PAL", // Philippine Airlines
  CZ: "CSN", // China Southern
  EW: "EWG", // Eurowings
  TN: "THT", // Air Tahiti Nui
};
