import type { Env } from "../../bindings.js";
import { isRecipientAllowed } from "./recipients.js";

/**
 * Sending mail, via Resend.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable per (sweep, recipient). Resend de-duplicates on it for 24h, which
   *  is the backstop against a retried tick double-sending. */
  idempotencyKey: string;
}

export type SendResult =
  | { status: "sent"; providerMessageId?: string }
  | { status: "skipped"; error: string }
  | { status: "failed"; error: string };

/**
 * Hand one message to Resend.
 *
 * Returns a result rather than throwing, because every outcome has to be
 * recordable: no failure email is ever sent, so `alert_deliveries` is the only
 * trace a dropped digest leaves, and "we never tried" (`skipped`) must not read
 * the same as "they refused" (`failed`). One is our configuration, the other is
 * theirs, and they are fixed in different places.
 */
export async function sendEmail(env: Env, msg: OutboundEmail): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    // Deliberately loud-by-record rather than silent: the sweep still runs and
    // still ingests, but the delivery row says why nothing arrived. Same posture
    // as `no_seats_aero_key` — an absence must never look like an empty result.
    return { status: "skipped", error: "no_resend_api_key" };
  }
  const from = env.ALERT_FROM;
  if (!from) return { status: "skipped", error: "no_alert_from" };
  // Checked again here, not only at write time in `validateAlerts`. Two
  // independent enforcements: one stops a bad address being stored, this one
  // stops a stored address that has since been removed from the list going out.
  if (!(await isRecipientAllowed(env, msg.to))) {
    return { status: "skipped", error: `recipient_not_allowed: ${msg.to}` };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": msg.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        // Replies go to the account, not into the void.
        reply_to: env.APP_USER_EMAIL,
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      // The provider's own body is usually the only explanation you get — an
      // unverified sending domain reads very differently from a bad key.
      return { status: "failed", error: `${res.status}: ${body.slice(0, 500)}` };
    }
    let providerMessageId: string | undefined;
    try {
      providerMessageId = (JSON.parse(body) as { id?: string }).id;
    } catch {
      /* a 2xx with an unparseable body still went out */
    }
    return { status: "sent", providerMessageId };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stable idempotency key for one (sweep, recipient). */
export async function idempotencyKey(sweepId: string, recipient: string): Promise<string> {
  const data = new TextEncoder().encode(`${sweepId}:${recipient.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
