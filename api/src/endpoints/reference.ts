import { Hono } from "hono";
import { AIRLINE_DIRECTORY } from "../domain/airlines.js";
import { CURRENCIES } from "../domain/programs.js";
import type { Env, Vars } from "../bindings.js";
import type { ProgramInfo } from "../../../shared/src/wire/index.js";

/**
 * Reference data: what the couple can pay with, and what they can fly.
 *
 * Two of the three are compile-time constants served verbatim, which is exactly
 * why `CurrencyInfo` and `AirlineInfo` are declared in the wire contract rather
 * than beside the arrays — the wire type IS the element type of what these
 * handlers hand back, so there is no second shape to drift.
 *
 * `/api/programs` is the odd one out and the reason this file has any SQL in it:
 * the `programs` table is the EDITABLE truth for names and transfer partners
 * (`seed/programs.sql` only seeds it), so that one is a read rather than a
 * constant.
 */
export const reference = new Hono<{ Bindings: Env; Variables: Vars }>();

// The couple's transferable currencies (reference constant, not per-user).
reference.get("/api/currencies", (c) => c.json(CURRENCIES));

// Carriers with the programs that can book them, derived from the seed alliance
// table (reference constant, like CURRENCIES). Names/transfer partners for those
// program codes come from /api/programs, which is the editable D1 truth.
reference.get("/api/airlines", (c) => c.json(AIRLINE_DIRECTORY));

/** The stored row, before `transfer_partners` is parsed out of its JSON column.
 *  That parse is what makes `ProgramInfo` a different shape from this, and is
 *  why annotating the mapped result below is a real check rather than a
 *  restatement of the SELECT. */
interface ProgramRow {
  code: string;
  name: string;
  kind: "airline" | "hotel";
  alliance: string | null;
  transfer_partners: string;
  is_active: number;
}

reference.get("/api/programs", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT code, name, kind, alliance, transfer_partners, is_active FROM programs WHERE is_active = 1 ORDER BY kind, name",
  ).all<ProgramRow>();
  const body: ProgramInfo[] = results.map((r) => ({
    ...r,
    transfer_partners: JSON.parse(String(r.transfer_partners)) as ProgramInfo["transfer_partners"],
  }));
  return c.json(body);
});
