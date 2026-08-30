import type { Env } from "../../bindings.js";
import { selectRecipientEmails } from "../../db/alertRecipients.js";

/**
 * Who this deployment may email.
 *
 * Split from `./email.ts` because it is a policy question rather than a
 * transport one, and because two slices ask it: the sweep asks before sending,
 * and the tracked-routes slice asks before storing a route's `alert_email`. Two
 * copies of that answer would let a route be saved pointing somewhere the sender
 * then refuses — a digest recorded `skipped` forever, with nothing announcing it.
 */

/** Recipients this Worker is allowed to send to, account address first.
 *
 *  With one shared password as the only auth, an unchecked `alert_email` would
 *  make this an arbitrary-recipient sender on a verified domain — and the
 *  domain's sending reputation is not something a typo should be able to spend.
 *
 *  The list is the `alert_recipients` table, edited from the
 *  settings dialog's System tab. `APP_USER_EMAIL` is always included and is
 *  never a row there, so an EMPTY TABLE still means "only the account's own
 *  address" — the safe default rather than the permissive one, and never "this
 *  deployment can email nobody".
 *
 *  Account address first because it is the answer to "who gets this by default":
 *  a route with a NULL `alert_email` resolves to it, and both the System tab and
 *  the route form render this order. */
export async function allowedRecipients(env: Env): Promise<string[]> {
  const stored = await selectRecipientEmails(env.DB);

  const self = env.APP_USER_EMAIL?.trim().toLowerCase();
  const list = self ? [self] : [];
  for (const raw of stored) {
    const email = raw.trim().toLowerCase();
    if (email && !list.includes(email)) list.push(email);
  }
  return list;
}

export async function isRecipientAllowed(env: Env, email: string): Promise<boolean> {
  return (await allowedRecipients(env)).includes(email.trim().toLowerCase());
}
