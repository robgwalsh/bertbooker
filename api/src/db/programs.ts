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
