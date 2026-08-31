import type { AlertDelivery } from "../models/wire/index.js";
import type { DeliveryRecord } from "../models/run.js";

/**
 * The `alert_deliveries` table — every digest this app tried to send, including
 * the ones that never went out.
 *
 * No failure email exists, so this table is the only trace a dropped digest
 * leaves, and "we never tried" (`skipped`) must not read the same as "they
 * refused" (`failed`). `WITHOUT ROWID` on `(sweep_id, to_email)`, which is also
 * the double-send guard.
 */

export async function insertDelivery(db: D1Database, v: DeliveryRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_deliveries
         (sweep_id, to_email, status, subject, change_count,
          provider_message_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sweep_id, to_email) DO NOTHING`,
    )
    .bind(
      v.sweepId,
      v.recipient,
      v.status,
      v.subject,
      v.changeCount,
      v.providerMessageId,
      v.error,
    )
    .run();
}

export async function selectDeliveries(db: D1Database, limit: number): Promise<AlertDelivery[]> {
  const { results } = await db
    .prepare("SELECT * FROM alert_deliveries ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<AlertDelivery>();
  return results ?? [];
}
