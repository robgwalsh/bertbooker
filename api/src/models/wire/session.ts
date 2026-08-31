// The password gate's two responses — `api/src/middleware/gate.ts` builds both by hand.
//
// **No token crosses this boundary.** Login answers with a `Set-Cookie` the
// browser stores and no script can read; `expiresAt` is the only thing in the
// body, and it is a hint about when to re-prompt, not a credential.

/** Response of `GET /api/auth/session`. */
export interface SessionState {
  /** False means the Worker is missing a required secret, so no password can
   *  ever work. A misconfiguration to report, not a login to prompt for. */
  configured: boolean;
  /** Which secret is missing, when `configured` is false. */
  reason?: "no_app_password" | "no_session_secret";
  authenticated: boolean;
  /** Epoch seconds, or null when not signed in. */
  expiresAt: number | null;
}

/** Response of `POST /api/auth/login`. The session itself arrives as an
 *  HttpOnly cookie, which is why there is no token here. */
export interface LoginResult {
  expiresAt: number;
}
