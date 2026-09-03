import { Hono } from "hono";
import { rowIdParam } from "../util/params.js";
import {
  deleteRecipient,
  insertRecipient,
  selectRecipientEmailById,
  selectRecipientIdByEmail,
  selectRecipients,
} from "../db/alertRecipients.js";
import { countRoutesUsingRecipient } from "../db/trackedRoutes.js";
import { upsertSetting } from "../db/settings.js";
import { ALERT_ALLOWANCE_KEY, clampAllowancePct } from "../features/alerts/scheduler-budget.js";
import type { Env, Vars } from "../bindings.js";
import type { AlertRecipients, AlertSettings, AlertSettingsInput } from "../models/wire/index.js";

/**
 * The deployment's own settings, as opposed to a route's.
 *
 * Two subjects: `alert_recipients`, the addresses this Worker may email an
 * alert digest to (`docs/ALERTS.md` §9), and the scheduler's share of the day's
 * seats.aero calls. Both were env bindings once (`ALERT_ALLOWED_RECIPIENTS`,
 * `ALERT_DAILY_BUDGET`), which meant a deploy per edit.
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

export const isEmailAddress = (email: string): boolean =>
  Boolean(email) && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);

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

/**
 * The allowance is read back through `GET /api/alerts/schedule` rather than a
 * GET here: the number only means anything beside the cadence and budget it
 * produces, and that endpoint already derives those from it.
 */
settings.put("/api/settings/alerts", async (c) => {
  const b = await c.req.json<Partial<AlertSettingsInput>>().catch(() => null);
  if (!b) return c.json({ error: "bad_body" }, 400);

  const pct = clampAllowancePct(b.allowancePct, -1);
  // Clamped for storage, but a request outside 0–100 is refused rather than
  // quietly clamped: a slider cannot send one, so an out-of-range value is a
  // caller that has misunderstood the unit.
  if (pct < 0 || pct !== b.allowancePct) {
    return c.json(
      { error: "bad_allowance", message: "The allowance must be a whole number from 0 to 100." },
      400,
    );
  }

  await upsertSetting(c.env.DB, ALERT_ALLOWANCE_KEY, String(pct));
  const body: AlertSettings = { allowancePct: pct };
  return c.json(body);
});
