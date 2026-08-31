import type { AlertRecipient } from "../models/wire/index.js";

/**
 * The `alert_recipients` table — the addresses this deployment may email.
 *
 * Every address here is stored trimmed and lowercased, which is what makes the
 * table's `UNIQUE` constraint a real guarantee and every comparison below an
 * exact match. `normalizeEmail` at the call site is what puts it in that form;
 * nothing in this module normalises on the way in.
 *
 * `APP_USER_EMAIL` is never a row. An empty table therefore means "only the
 * account's own address", which is the safe default rather than the permissive
 * one — see `features/alerts/recipients.ts`, which composes the two.
 */

/** Just the addresses, for the allowlist check. */
export async function selectRecipientEmails(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT email FROM alert_recipients ORDER BY email")
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

/** The rows the System tab renders. */
export async function selectRecipients(db: D1Database): Promise<AlertRecipient[]> {
  const { results } = await db
    .prepare("SELECT id, email, created_at FROM alert_recipients ORDER BY email")
    .all<AlertRecipient>();
  return results;
}

export async function selectRecipientIdByEmail(
  db: D1Database,
  email: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM alert_recipients WHERE email = ?")
    .bind(email)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function insertRecipient(db: D1Database, email: string): Promise<number | undefined> {
  const row = await db
    .prepare("INSERT INTO alert_recipients (email) VALUES (?) RETURNING id")
    .bind(email)
    .first<{ id: number }>();
  return row?.id;
}

export async function selectRecipientEmailById(
  db: D1Database,
  id: number,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT email FROM alert_recipients WHERE id = ?")
    .bind(id)
    .first<{ email: string }>();
  return row?.email ?? null;
}

export async function deleteRecipient(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM alert_recipients WHERE id = ?").bind(id).run();
}
