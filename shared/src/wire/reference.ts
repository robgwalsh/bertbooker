// Reference data as the API serves it.
//
// `CurrencyInfo` and `AirlineInfo` are declared here rather than beside the
// constants that populate them: `GET /api/currencies` and `GET /api/airlines`
// answer `c.json(CURRENCIES)` and `c.json(AIRLINE_DIRECTORY)` verbatim, so the
// wire type IS the element type of those arrays. `api/src/domain/programs.ts`
// and `airlines.ts` re-export these and annotate their constants against them,
// which is what keeps the served shape and the declared one in step.
//
// `ProgramInfo` is the exception and is spelled out separately, because it is
// NOT `ProgramSeed`: the handler reads a D1 row and JSON-parses one column on
// the way out, so the wire shape is snake_case and post-processed.

import type { Alliance, Currency } from "./domain.js";

export interface CurrencyInfo {
  code: Currency;
  name: string;
}

/** Wire shape for `GET /api/airlines`: the seed with its programs resolved. The
 *  web app joins `programs[]` against `/api/programs` (the editable D1 table) for
 *  names and transfer partners, so currencies stay single-sourced there. */
export interface AirlineInfo {
  code: string;
  name: string;
  country: string;
  alliance: Alliance;
  programs: string[];
}

/** `GET /api/programs` — a `programs` row with `transfer_partners` already
 *  parsed out of its JSON column. The parse is what makes this a different
 *  shape from the stored row, and the reason annotating that handler is a real
 *  check rather than a restatement. */
export interface ProgramInfo {
  code: string;
  name: string;
  kind: "airline" | "hotel";
  alliance: string | null;
  transfer_partners: { currency: string; ratio: string }[];
  is_active: number;
}
