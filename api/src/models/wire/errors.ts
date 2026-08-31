// The error envelope, and the vocabulary of machine-readable codes in it.
//
// The Worker answers failures as `{ error }` or `{ error, message }`. Most of
// those literals are inline at their throw sites and stay that way — converting
// all eighteen would be churn for its own sake. What is worth naming is the
// CODE SET, because the SPA branches on it: `SEARCH_ERRORS` in
// `app/src/api/client.ts` turns codes into sentences, and `locked` drives the
// whole session-expiry hand-off.
//
// Typing that lookup as `Partial<Record<ApiErrorCode, string>>` is the point of
// this file: a code the app explains but the Worker never sends, or a rename on
// one side only, becomes a compile error instead of a message nobody ever sees.

export interface ApiErrorBody {
  error: string;
  message?: string;
}

/**
 * Every machine-readable code the Worker sends.
 *
 * Gathered from the `error:` literals across `api/src`, plus the two the gate
 * reports as a missing-secret `reason`. Not all of them are explained to the
 * user — `SEARCH_ERRORS` covers the ones a person can act on, and the rest fall
 * back to the raw message.
 */
export type ApiErrorCode =
  // The gate and the session
  | "locked"
  | "unauthenticated"
  | "bad_password"
  | "no_app_password"
  | "no_session_secret"
  // Search
  | "no_seats_aero_key"
  | "window_outside_horizon"
  | "bad_route_spec"
  | "bad_window"
  | "nothing_to_resume"
  | "run_not_found"
  // Enrich
  | "not_enrichable"
  | "enrich_failed"
  | "nothing_to_enrich"
  // Alerts
  | "bad_alert_types"
  | "recipient_not_allowed"
  | "no_alert_from"
  | "no_resend_api_key"
  // The recipient allowlist (`alert_recipients`)
  | "bad_email"
  | "duplicate_recipient"
  | "recipient_in_use"
  // Route graph
  | "unknown_source"
  | "routes_fetch_failed"
  // Generic
  | "not_found"
  | "bad_request";
