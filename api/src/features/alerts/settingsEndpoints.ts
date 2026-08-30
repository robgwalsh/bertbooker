import { Hono } from "hono";
import { rowIdParam } from "../../util/params.js";
import {
  deleteRecipient,
  insertRecipient,
  selectRecipientEmailById,
  selectRecipientIdByEmail,
  selectRecipients,
} from "../../db/alertRecipients.js";
import { countRoutesUsingRecipient } from "../../db/trackedRoutes.js";
import type { Env, Vars } from "../../bindings.js";
import type { AlertRecipients } from "../../../../shared/src/wire/index.js";

/**
 * The deployment's own settings, as opposed to a route's.
 *
 * One subject today: `alert_recipients`, the addresses this Worker may email an
 * alert digest to (`docs/ALERTS.md` §9). It was
 * `ALERT_ALLOWED_RECIPIENTS`, a CSV env binding, which meant a deploy per edit.
 *
 * Nothing here is scoped to an owner, because nothing in this database is. What
 * the list bounds is the Worker's outbound sending on a verified domain — a
 * property of the deployment rather than of an account.
 */
export const settings = new Hono<{ Bindings: Env; Variables: Vars }>();

/** The longest address any mail system will carry. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately conservative, and deliberately not RFC 5322.
 *
 * A full grammar accepts quoted local parts and bracketed literals that no
 * mailbox anyone types here will ever use, and every character it lets through
 * is one more thing that reaches Resend. What this has to catch is a typo —
 * a missing `@`, a trailing comma left over from the CSV this replaced, a
 * pasted display name — and rejecting an exotic-but-legal address is a far
 * cheaper mistake than accepting a malformed one.
 */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/;

/** Exported only so `settings.test.ts` can reach it — the Hono handlers around
 *  it hold nothing else worth testing, the same arrangement `routeFilter` uses
 *  in `seatsaeroRoutes.ts`. */
export const isEmailAddress = (email: string): boolean =>
  Boolean(email) && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);

/** Trimmed and lowercased, which is the form the table stores and every
 *  comparison uses. `UNIQUE` is only a real guarantee because of this.
 *  Exported for the same reason as above. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const accountAddress = (env: Env): string | null =>
  env.APP_USER_EMAIL ? normalizeEmail(env.APP_USER_EMAIL) : null;

settings.get("/api/settings/recipients", async (c) => {
  const body: AlertRecipients = {
    accountAddress: accountAddress(c.env),
    recipients: await selectRecipients(c.env.DB),
  };
  return c.json(body);
});

settings.post("/api/settings/recipients", async (c) => {
  const b = await c.req.json<{ email?: string }>().catch(() => null);
  if (!b) return c.json({ error: "bad_body" }, 400);

  const email = normalizeEmail(b.email ?? "");
  if (!isEmailAddress(email)) {
    return c.json({ error: "bad_email", message: `${b.email ?? ""} is not an email address.` }, 400);
  }

  // The account address is allowed unconditionally and is never a row, so
  // storing it would be a second source of truth for one address — and would
  // make the one address every NULL `alert_email` falls back to deletable.
  if (email === accountAddress(c.env)) {
    return c.json(
      {
        error: "duplicate_recipient",
        message: "The account address is always allowed and cannot be added.",
      },
      400,
    );
  }

  const existing = await selectRecipientIdByEmail(c.env.DB, email);
  if (existing !== null) {
    return c.json(
      { error: "duplicate_recipient", message: `${email} is already allowed.` },
      400,
    );
  }

  return c.json({ id: await insertRecipient(c.env.DB, email) }, 201);
});

/**
 * Removing an address, and the one case this refuses.
 *
 * A tracked route pointing at an address that is no longer allowed does not
 * fail loudly. Its digest is recorded `skipped` with `recipient_not_allowed`,
 * and because only a SUCCESSFUL send clears `alert_outbox`, the rows stay and
 * every following cycle retries the same refusal forever. No failure email is
 * ever sent, so nothing announces it.
 *
 * That is the invisible failure `docs/ALERTS.md` §1 exists against, and one
 * COUNT is a cheap price for not creating it from a delete button. Point the
 * route somewhere else first.
 */
settings.delete("/api/settings/recipients/:id", async (c) => {
  const id = rowIdParam(c.req.param("id"));
  if (id === null) return c.json({ error: "bad_id" }, 400);

  const stored = await selectRecipientEmailById(c.env.DB, id);
  if (stored === null) return c.json({ error: "not_found" }, 404);

  const n = await countRoutesUsingRecipient(c.env.DB, stored);
  if (n > 0) {
    return c.json(
      {
        error: "recipient_in_use",
        message: `${stored} is where ${n} route${n === 1 ? "" : "s"} send${
          n === 1 ? "s" : ""
        } alerts. Point ${n === 1 ? "it" : "them"} elsewhere first.`,
      },
      400,
    );
  }

  await deleteRecipient(c.env.DB, id);
  return c.json({ ok: true });
});
