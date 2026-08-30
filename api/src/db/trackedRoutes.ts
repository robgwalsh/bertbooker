/**
 * The `tracked_routes` table — the saved searches everything else hangs off.
 *
 * One module for one table, so the several surfaces that read it cannot quietly
 * grow two versions of the same projection. Note that they legitimately project
 * DIFFERENT column lists: the Routes page needs every settable column because it
 * seeds the edit form from them, the search planner needs nine, and the reach
 * report needs six. Each has its own function and its own row type here.
 *
 * `tracked_routes` carries NO INDEX and should not grow one — seven rows, and
 * "which route is most overdue" is a pure function over rows already in memory,
 * not SQL. An index here would only make the pacing-clock UPDATE bill two D1
 * rows instead of one.
 */

/** How many routes send their digest to this address. Read before deleting a
 *  recipient — see the delete handler for why that check exists. */
export async function countRoutesUsingRecipient(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tracked_routes WHERE lower(trim(alert_email)) = ?")
    .bind(email)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
