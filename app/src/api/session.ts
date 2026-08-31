// ---------------------------------------------------------------------------
// The password gate
// ---------------------------------------------------------------------------
// These three calls are the only ones outside the gate, and they bypass `req` on
// purpose: a wrong password is a 401 that must reach the dialog as a message,
// not trip the global lockout handler that `req` owns.
//
// **No token crosses this boundary.** Login answers with a `Set-Cookie` the
// browser stores and this code cannot see; `expiresAt` is the only thing in the
// body, and it is a hint about when to re-prompt, not a credential.

import { ApiError } from "./client";
import type { LoginResult, SessionState } from "../../../api/src/models/wire/index.js";

export async function session(): Promise<SessionState> {
  const res = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, null, `GET /auth/session -> ${res.status}`);
  return (await res.json()) as SessionState;
}

/** Exchange the shared password for a session cookie. Throws `ApiError` with
 *  code `bad_password` on a wrong one, or `no_app_password` /
 *  `no_session_secret` if the Worker is missing a secret. */
export async function login(password: string): Promise<LoginResult> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = (await res.json().catch(() => null)) as
    | (Partial<LoginResult> & { error?: string })
    | null;
  if (!res.ok || typeof body?.expiresAt !== "number") {
    throw new ApiError(res.status, body?.error ?? null, `POST /auth/login -> ${res.status}`);
  }
  return { expiresAt: body.expiresAt };
}

/**
 * Clear the session cookie. Never throws: sign-out is a thing the user asked
 * for, and a failed request is no reason to leave them looking at an app they
 * think they have left. The client-side clear happens regardless.
 *
 * The `Content-Type` is not decoration on a request with no body. The Worker's
 * `csrf` middleware guards exactly the requests a cross-site *form* could have
 * made, and a POST with no content type counts as one — so without this header
 * this call is refused 403 by our own CSRF protection. Declaring JSON is also
 * what makes the guard correct rather than incidental: browsers cannot send that
 * content type cross-site without a preflight, which our CORS policy refuses.
 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  }).catch(() => {});
}
