import type { Env } from "./bindings.js";

/**
 * Sending mail, via Resend.
 *
 * **This is the Worker's SECOND outbound host, and the distinction is what makes
 * it allowed.** The standing rule is that the Worker never *gathers* from a
 * source it cannot authenticate to — airlines refuse datacenter IPs, and United
 * and Delta refuse raw HTTP from anywhere. Resend is not a data source at all:
 * it is a delivery channel, and a keyed vendor API on exactly the same footing
 * as seats.aero — it wants the key, not a browser. Nothing about the airline
 * prohibition changes. The whole list of what this Worker may talk to is
 * "inbound data: seats.aero; outbound notification: Resend", and it is written
 * out in `workers/api/wrangler.toml` beside the bindings it explains.
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

/** Recipients this Worker is allowed to send to.
 *
 *  With one shared password as the only auth, an unchecked `alert_email` would
 *  make this an arbitrary-recipient sender on a verified domain — and the
 *  domain's sending reputation is not something a typo should be able to spend.
 *  Unset means "only the account's own address", which is the safe default
 *  rather than the permissive one. */
export function allowedRecipients(env: Env): string[] {
  const csv = (env.ALERT_ALLOWED_RECIPIENTS ?? "").trim();
  const listed = csv
    ? csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const self = env.APP_USER_EMAIL?.trim().toLowerCase();
  if (self && !listed.includes(self)) listed.push(self);
  return listed;
}

export function isRecipientAllowed(env: Env, email: string): boolean {
  return allowedRecipients(env).includes(email.trim().toLowerCase());
}

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
  if (!isRecipientAllowed(env, msg.to)) {
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
