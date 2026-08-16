/**
 * Client half of the shared-password gate (`workers/api/src/gate.ts`).
 *
 * **There is no credential in this file, and that is the point.** The session is
 * an `HttpOnly` cookie the Worker sets at login: the browser attaches it to every
 * same-origin request automatically, and no script — ours, or one that got onto
 * the page — can read it. It used to be a bearer token in `localStorage`, which
 * meant an XSS could copy it once and replay it from anywhere for the remaining
 * eight hours.
 *
 * What is left here is a **hint**: the expiry the Worker reported at login. It
 * unlocks nothing, and the Worker re-derives the real answer from the cookie on
 * every request. It exists so a returning user inside their eight hours sees the
 * app immediately instead of a spinner while `GET /api/auth/session` decides.
 *
 * The old note claiming a cookie was impractical because dev splits the SPA
 * (:5173) from the API (:8787) was wrong by the time it mattered: Vite proxies
 * `/api` to the Worker, so the browser only ever sees one origin and the cookie
 * is same-site in dev exactly as it is in production.
 */

/** Follows the `bertbooker.<area>.<thing>` convention. */
const STORAGE_KEY = "bertbooker.auth.expiresAt";

export interface SessionHint {
  /** Epoch SECONDS, as reported by the Worker at login. */
  expiresAt: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The stored expiry hint, or null if there isn't one or it has lapsed.
 *
 * Checked here as well as on the Worker so a returning tab shows the password
 * dialog immediately rather than after a round trip that was always going to
 * 401. The Worker's check is the authoritative one; this is only the client
 * deciding what to draw first.
 */
export function readSessionHint(): SessionHint | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const expiresAt = Number(raw);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds()) return null;
    return { expiresAt };
  } catch {
    // Private mode, quota, a half-written value — any of these mean "assume
    // nothing", never a crash on the way to drawing the login box.
    return null;
  }
}

export function writeSessionHint(hint: SessionHint): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(hint.expiresAt));
  } catch {
    // Storage refused; the session still works, we just re-check on next load.
  }
}

export function clearSessionHint(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do.
  }
}

// ---------------------------------------------------------------------------
// Lockout notification
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Subscribe to "the Worker just refused us".
 *
 * A session can die between page loads — the 8 hours elapse, or the password is
 * rotated under a tab that's been open all day. Without this, the first thing
 * the user sees is every panel failing at once with a generic error. `api.ts`
 * calls `notifyLocked` on any 401 carrying `{"error":"locked"}`, and the gate
 * component re-prompts.
 */
export function onLocked(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyLocked(): void {
  clearSessionHint();
  for (const listener of listeners) listener();
}
