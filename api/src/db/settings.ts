/**
 * The `settings` table — the deployment's own knobs, keyed by name.
 *
 * Values are stored as text and parsed by whoever owns the key; an absent row
 * is the default, so nothing here knows what any setting means.
 */

export async function selectSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function upsertSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = unixepoch() * 1000`,
    )
    .bind(key, value)
    .run();
}
