import type { ProgramRow } from "../models/program.js";

/**
 * Reads of the `programs` table — the editable truth for a loyalty program's
 * name, alliance and transfer partners.
 *
 * `api/src/models/program.ts` is the SEED for this table and a different thing:
 * it is a compile-time constant that `sources/registry.ts` validates a source's
 * declared programs against at boot, and `seed/programs.sql` mirrors it. What
 * this module reads is the row somebody may since have edited.
 */

export async function selectActivePrograms(db: D1Database): Promise<ProgramRow[]> {
  const { results } = await db
    .prepare(
      "SELECT code, name, kind, alliance, transfer_partners, is_active FROM programs WHERE is_active = 1 ORDER BY kind, name",
    )
    .all<ProgramRow>();
  return results;
}

/**
 * Which currencies book each active program, off the editable table.
 *
 * A find's own `transfer_currencies` column is what the seed said when the row
 * was written; a route's currency filter reads this instead, so editing a
 * partner surfaces the finds already stored without waiting for a rewrite.
 */
export async function selectProgramCurrencies(db: D1Database): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const p of await selectActivePrograms(db)) {
    try {
      const partners: unknown = JSON.parse(p.transfer_partners);
      if (!Array.isArray(partners)) continue;
      out.set(
        p.code,
        partners
          .map((t) => String((t as { currency?: unknown })?.currency ?? ""))
          .filter(Boolean),
      );
    } catch {
      /* an unparseable row falls back to the find's own column */
    }
  }
  return out;
}
