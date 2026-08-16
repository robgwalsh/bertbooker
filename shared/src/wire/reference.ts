// Reference data as the API serves it.
//
// `CurrencyInfo` and `AirlineInfo` are not redefined here: `GET /api/currencies`
// and `GET /api/airlines` answer `c.json(CURRENCIES)` and
// `c.json(AIRLINE_DIRECTORY)` — the shared constants, verbatim — so the domain
// type IS the wire type and re-exporting it is the whole of the contract.
//
// `ProgramInfo` is the exception and is spelled out below, because it is NOT
// `ProgramSeed`: the handler reads a D1 row and JSON-parses one column on the
// way out, so the wire shape is snake_case and post-processed.

export type { CurrencyInfo } from "../data/programs.js";
export type { AirlineInfo } from "../data/airlines.js";

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
