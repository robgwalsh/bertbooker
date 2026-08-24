// ---------------------------------------------------------------------------
// Settings — the deployment's own knobs, as opposed to a route's.
// ---------------------------------------------------------------------------
//
// One subject today: the addresses the Worker may email an alert digest to.
// It lives here rather than in `alerts.ts` because it is edited from the
// settings dialog and read by the route form, neither of which is the Alerts
// tab, and because it bounds the WORKER's sending rather than any one route's.

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
