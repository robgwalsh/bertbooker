-- The addresses this Worker is allowed to email a digest to.
--
-- Moved here from ALERT_ALLOWED_RECIPIENTS, a CSV env binding. What that cost
-- was a deploy per edit: `wrangler secret put` in production, a line in
-- api/.dev.vars plus an API restart locally, because wrangler does not reload
-- that file. A list of two addresses that changes when a person changes is data,
-- not configuration.
--
-- What it protects is unchanged, and is the reason the list exists at all: with
-- one shared password as the only auth, an unchecked per-route `alert_email`
-- would make this an arbitrary-recipient sender on a Resend-verified domain, and
-- the domain's sending reputation is not something a typo should be able to
-- spend. Enforcement is still twice — `validateAlerts` at write time and
-- `sendEmail` at send time (docs/ALERTS.md §9).
--
-- NOT SCOPED BY user_email, unlike `tracked_routes`. What this table bounds is
-- the WORKER's outbound sending on a verified domain, which is a property of the
-- deployment rather than of an account — reference data in the same sense
-- `programs` is. There is one identity behind the password anyway.
--
-- `email` is stored TRIMMED AND LOWERCASED, normalised at the API before it ever
-- reaches this table, which is what makes UNIQUE a real uniqueness guarantee
-- rather than a case-sensitive one. Reads compare lowercased for the same
-- reason.
--
-- APP_USER_EMAIL IS NEVER A ROW HERE. It is allowed unconditionally, so storing
-- it would be a second source of truth for one address and would make the
-- account's own address deletable — leaving a deployment that cannot email the
-- one recipient every route falls back to.
--
-- An INTEGER PRIMARY KEY rather than keying on the address itself, so DELETE
-- takes an id through the existing `rowIdParam` helper, the same shape as every
-- other delete in this API.

CREATE TABLE IF NOT EXISTS alert_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
