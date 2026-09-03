// ---------------------------------------------------------------------------
// Settings — the deployment's own knobs, as opposed to a route's.
// ---------------------------------------------------------------------------
//
// Two subjects: the addresses the Worker may email an alert digest to, and the
// share of the day's seats.aero calls the scheduler may spend. Both bound the
// WORKER rather than any one route, which is what makes them settings. The
// allowlist is edited from the settings dialog and read by the route form; the
// allowance is edited from the Alerts page, beside the cadence it produces.

/** One row of `alert_recipients` — an address the Worker may send a digest to.
 *
 *  Asserted about `SELECT id, email, created_at FROM alert_recipients`. */
export interface AlertRecipient {
  id: number;
  /** Always trimmed and lowercased; the API normalises before storing. */
  email: string;
  created_at: number;
}

/** `GET /api/settings/recipients` — the whole allowlist, in the order it is
 *  rendered.
 *
 *  `accountAddress` is `APP_USER_EMAIL`. It is allowed unconditionally and is
 *  never a row in `recipients`, so it cannot be removed — which is what stops an
 *  empty table meaning "this deployment can email nobody". It is also the
 *  address a route with a NULL `alert_email` falls back to, so the settings tab
 *  and the route form both need it, and both take it from here rather than
 *  guessing at what the server treats as implicit. `null` when `APP_USER_EMAIL`
 *  is unset, which is a deployment that cannot send at all. */
export interface AlertRecipients {
  accountAddress: string | null;
  recipients: AlertRecipient[];
}

/** `POST /api/settings/recipients` */
export interface AlertRecipientInput {
  email: string;
}

/** `PUT /api/settings/alerts` — the scheduler's share of the day's seats.aero
 *  calls, 0–100. The current value rides on `GET /api/alerts/schedule` as
 *  `budget.allowancePct`, beside the figures it produces. */
export interface AlertSettingsInput {
  allowancePct: number;
}

/** What the PUT answers: the value as stored. */
export interface AlertSettings {
  allowancePct: number;
}
