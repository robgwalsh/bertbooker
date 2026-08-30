/**
 * Reads of the `programs` table — the editable truth for a loyalty program's
 * name, alliance and transfer partners.
 *
 * `api/src/domain/programs.ts` is the SEED for this table and a different thing:
 * it is a compile-time constant that `sources/registry.ts` validates a source's
 * declared programs against at boot, and `seed/programs.sql` mirrors it. What
 * this module reads is the row somebody may since have edited.
 */

/** The stored row, before `transfer_partners` is parsed out of its JSON column.
 *  That parse is what makes `ProgramInfo` a different shape from this, and is
 *  why annotating the mapped result at the call site is a real check rather than
 *  a restatement of the SELECT. */
export interface ProgramRow {
  code: string;
  name: string;
  kind: "airline" | "hotel";
  alliance: string | null;
  transfer_partners: string;
  is_active: number;
}

export async function selectActivePrograms(db: D1Database): Promise<ProgramRow[]> {
  const { results } = await db
    .prepare(
      "SELECT code, name, kind, alliance, transfer_partners, is_active FROM programs WHERE is_active = 1 ORDER BY kind, name",
    )
    .all<ProgramRow>();
  return results;
}
