// The Library's brand system: alliance accents, the domain maps behind each
// favicon, and the monogram fallback. Presentation-only data — no JSX — keyed by
// this app's own program/currency/carrier codes.
//
// The currencies' own issuer domains are NOT here: they live in
// `lib/currencies.ts` beside `CurrencyIcon`'s other inputs, because every page
// draws those marks and this one is not their only reader.

import type { Theme } from "@mui/material/styles";
import { readable } from "../../../theme/build";
import { CURRENCY_LABEL } from "../../../lib/currencies";
import type { ProgramInfo } from "../../../api";

export const ALLIANCE: Record<string, { label: string; color: string }> = {
  star: { label: "Star Alliance", color: "#6ea8fe" },
  oneworld: { label: "oneworld", color: "#f5c451" },
  skyteam: { label: "SkyTeam", color: "#c084fc" },
};

// Brand domains for favicon lookup (presentation-only; keyed by our program/
// currency codes). Missing codes fall back to the monogram / color dot.
export const PROGRAM_DOMAIN: Record<string, string> = {
  aeroplan: "aircanada.com",
  lifemiles: "lifemiles.com",
  turkish: "turkishairlines.com",
  united: "united.com",
  eva: "evaair.com",
  ana: "ana.co.jp",
  singapore: "singaporeair.com",
  flyingblue: "flyingblue.com",
  virginatlantic: "virginatlantic.com",
  avios: "britishairways.com",
  aadvantage: "aa.com",
  alaska: "alaskaair.com",
  cathay: "cathaypacific.com",
  jetblue: "jetblue.com",
  qantas: "qantas.com",
  emirates: "emirates.com",
  etihad: "etihad.com",
  hyatt: "hyatt.com",
  marriott: "marriott.com",
  ihg: "ihg.com",
  accor: "accor.com",
  wyndham: "wyndhamhotels.com",
  choice: "choicehotels.com",
};

// Same idea, keyed by IATA carrier code (see AIRLINE_SEEDS in `api/src/models/airline.ts`).
export const AIRLINE_DOMAIN: Record<string, string> = {
  AC: "aircanada.com",
  UA: "united.com",
  LH: "lufthansa.com",
  LX: "swiss.com",
  OS: "austrian.com",
  SN: "brusselsairlines.com",
  TK: "turkishairlines.com",
  SQ: "singaporeair.com",
  NH: "ana.co.jp",
  OZ: "flyasiana.com",
  AI: "airindia.com",
  AV: "avianca.com",
  CM: "copaair.com",
  BR: "evaair.com",
  TP: "flytap.com",
  TG: "thaiairways.com",
  ET: "ethiopianairlines.com",
  MS: "egyptair.com",
  LO: "lot.com",
  A3: "aegeanair.com",
  NZ: "airnewzealand.com",
  CA: "airchina.com",
  AA: "aa.com",
  BA: "britishairways.com",
  IB: "iberia.com",
  QR: "qatarairways.com",
  CX: "cathaypacific.com",
  JL: "jal.co.jp",
  AY: "finnair.com",
  QF: "qantas.com",
  MH: "malaysiaairlines.com",
  AS: "alaskaair.com",
  RJ: "rj.com",
  AT: "royalairmaroc.com",
  EI: "aerlingus.com",
  DL: "delta.com",
  AF: "airfrance.com",
  KL: "klm.com",
  KE: "koreanair.com",
  VS: "virginatlantic.com",
  AM: "aeromexico.com",
  AZ: "ita-airways.com",
  CI: "china-airlines.com",
  MU: "ceair.com",
  VN: "vietnamairlines.com",
  GA: "garuda-indonesia.com",
  SV: "saudia.com",
  KQ: "kenya-airways.com",
  SK: "flysas.com",
  EK: "emirates.com",
  EY: "etihad.com",
  B6: "jetblue.com",
  HA: "hawaiianairlines.com",
  VA: "virginaustralia.com",
  FJ: "fijiairways.com",
  JX: "starlux-airlines.com",
  DE: "condor.com",
};

// Alliance accent, with the "no alliance" fallback shared by programs and
// carriers. The fallbacks are palette ROLES rather than the old theme's indigo
// and teal, so an unaligned carrier and a hotel program pick up whichever theme
// is on instead of staying two colours nothing else on the page uses.
export function allianceColor(alliance: string | null, theme: Theme): string {
  const a = alliance ? ALLIANCE[alliance] : undefined;
  return readable(a ? a.color : theme.palette.secondary.main, theme);
}

// Brand-ish accent per program: alliance color for airlines, the theme's
// secondary for hotels.
export function tileColor(p: ProgramInfo, theme: Theme): string {
  return p.kind === "hotel" ? theme.palette.secondary.main : allianceColor(p.alliance, theme);
}

// Placeholder "logo" until real assets exist: initials from the program name.
export function monogram(name: string): string {
  const stop = new Set(["of", "the", "and", "&"]);
  const words = name
    .replace(/[/()]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase()));
  const [first, second] = words;
  if (!first) return name.slice(0, 2).toUpperCase();
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first[0]! + second[0]!).toUpperCase();
}

// "Avios (BA / Iberia / …)" -> "Avios". The parenthetical is useful in the
// programs table and pure noise in a wrapped row of chips.
export function shortProgramName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim();
}

// Wallet order for the currency marks, so every row reads left-to-right the same.
export const CURRENCY_ORDER = Object.keys(CURRENCY_LABEL);
