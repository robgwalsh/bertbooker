import { type DigestRoute, groupForRecipients, renderDigest } from "./digest.js";
import { routeLabel, type AlertRouteRow } from "./alertRoutes.js";
import { idempotencyKey, sendEmail } from "./email.js";
import type { ChangeSummary } from "../../models/change.js";
import type { Env } from "../../bindings.js";
import { selectQuietAlertRoutes, stampAlertDigestForRoutes } from "../../db/trackedRoutes.js";
import { deleteOldRuns, selectCycleCounts } from "../../db/runs.js";
import { deleteOutboxForRoutes, selectOutboxForDigest } from "../../db/alertOutbox.js";
import { insertDelivery } from "../../db/alertDeliveries.js";

/**
 * The notification half of the sweep: when a digest goes out, and what is in it.
 */

/** How long a run row is kept. The Alerts tab shows 25, the pacing lookup wants
 *  the most recent one per route, and the budget guard only ever asks about
 *  today — so this is generous to every reader and still bounds the table at
 *  roughly 1,500 rows instead of growing by ~50 a day forever. */
const RUN_RETENTION_DAYS = 30;

/** Delete run rows older than the retention window.
 *
 *  Deliberately unbounded by a LIMIT: at ~50 rows a day the steady-state delete
 *  is a handful, and a first run after a long gap should get it over with rather
 *  than leave a backlog that never drains. A run still `running` is spared
 *  whatever its age — that is a paused search waiting to resume, and deleting it
 *  would strand the sweep that owns it. */
export async function pruneOldRuns(env: Env, now: number): Promise<void> {
  await deleteOldRuns(env.DB, now - RUN_RETENTION_DAYS * 86_400_000);
}

export async function cycleComplete(
  env: Env,
  intervalMinutes: number,
  now: number,
): Promise<boolean> {
  const { due, running } = await selectCycleCounts(env.DB, now - intervalMinutes * 60_000);
  return due === 0 && running === 0;
}

/**
 * Send what is waiting, one digest per recipient.
 *
 * Every outcome is recorded in `alert_deliveries`, including the ones where
 * nothing was sent. No failure email exists, so that table is the only trace a
 * dropped digest leaves — and "we never tried" must not read the same as "they
 * refused".
 */
export async function flushOutbox(env: Env, email: string, now: number): Promise<number> {
  const results = await selectOutboxForDigest(env.DB);
  if (!results.length) return 0;

  const perRoute = new Map<number, DigestRoute>();
  for (const row of results) {
    const routeId = Number(row.route_id);
    let entry = perRoute.get(routeId);
    if (!entry) {
      entry = {
        routeId,
        label: routeLabel({
          ...row,
          origin: row.route_origin,
          destination: row.route_destination,
        } as unknown as AlertRouteRow),
        recipient: (row.alert_email as string | null) ?? email,
        changes: [],
      };
      perRoute.set(routeId, entry);
    }
    entry.changes.push({
      type: String(row.type) as ChangeSummary["type"],
      key: String(row.change_key),
      flightDate: String(row.flight_date),
      program: String(row.program),
      cabin: String(row.cabin),
      origin: String(row.origin ?? ""),
      destination: String(row.destination ?? ""),
      milesCost: row.miles_cost == null ? undefined : Number(row.miles_cost),
      seatsAvailable: row.seats == null ? undefined : Number(row.seats),
      previousMilesCost: row.prev_miles == null ? undefined : Number(row.prev_miles),
      previousSeats: row.prev_seats == null ? undefined : Number(row.prev_seats),
    });
  }

  // Routes swept this cycle with nothing to say are named in the digest rather
  // than omitted — "three checked, two quiet" and "only one ran" are different
  // facts and no failure email exists to tell them apart.
  const quiet = await selectQuietAlertRoutes(env.DB);

  const digestRoutes: DigestRoute[] = [
    ...perRoute.values(),
    ...quiet.map((r) => ({
      routeId: r.id,
      label: routeLabel(r),
      recipient: r.alert_email ?? email,
      changes: [],
    })),
  ];

  const sweepId = crypto.randomUUID();
  const grouped = groupForRecipients(digestRoutes, env.APP_URL);
  let sent = 0;

  for (const [recipient, input] of grouped) {
    const rendered = renderDigest(input);
    const outcome = await sendEmail(env, {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: await idempotencyKey(sweepId, recipient),
    });
    await insertDelivery(env.DB, {
      sweepId,
      recipient,
      status: outcome.status,
      subject: rendered.subject,
      changeCount: input.groups.reduce((n, g) => n + g.changes.length, 0),
      providerMessageId: outcome.status === "sent" ? (outcome.providerMessageId ?? null) : null,
      error: outcome.status === "sent" ? null : outcome.error,
    });

    if (outcome.status === "sent") {
      sent += 1;
      // Only clear what we actually told someone about. A refused send leaves
      // the outbox intact so the next cycle tries again rather than losing it.
      const ids = input.groups.map((g) => g.routeId);
      await deleteOutboxForRoutes(env.DB, ids);
      await stampAlertDigestForRoutes(env.DB, ids, now);
    }
  }
  return sent;
}
