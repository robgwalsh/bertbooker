import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { Env, Vars } from "../bindings.js";
import type { LoginResult, SessionState } from "../../../shared/src/wire/index.js";

/**
 * The shared-password gate.
 *
 * This app is for two people and holds no third-party data, so the gate is
 * deliberately the smallest thing that works: one secret both of them know,
 * checked by the Worker, exchanged for a session cookie that lasts 8 hours.
 * There is no user table behind it, no password reset, no per-person account —
 * `auth.ts` still owns *identity*, and this owns *entry*.
 *
 * Four properties are worth more than the simplicity:
 *
 * - **The password never leaves the Worker.** The SPA is a static bundle — served
 *   by this same worker, but a bundle all the same — and can hide nothing; only
 *   the server can compare against the secret.
 * - **The session is signed with a key the password cannot be recovered from.**
 *   Signing directly with `APP_PASSWORD` would make every token an offline
 *   cracking oracle: the message is public and predictable, so anyone holding
 *   one token could grind candidate passwords at billions per second against it
 *   and walk away with the secret that guards everything else. The key is HKDF
 *   over a high-entropy `SESSION_SECRET`, **salted with the password's
 *   digest** — which is what keeps rotating `APP_PASSWORD` a revocation: it
 *   changes the key, so every live session dies.
 * - **The session never touches JavaScript.** It is an `HttpOnly`,
 *   `SameSite=Strict` cookie, so an XSS on this page cannot read it, copy it, or
 *   replay it from somewhere else eight hours later. The SPA holds nothing but an
 *   expiry hint for deciding when to re-prompt.
 * - **It fails closed.** An unset `APP_PASSWORD` *or* `SESSION_SECRET` refuses
 *   every request with a 503 that names the missing one, exactly as a missing
 *   `SEATS_AERO_API_KEY` does. The alternative — treating "no secret configured"
 *   as "no gate" — would mean one forgotten `wrangler secret put` silently
 *   publishes the whole app, and a security control whose failure mode is
 *   silence is not a security control.
 */

/** How long a successful login lasts. */
const SESSION_SECONDS = 8 * 60 * 60;

/** Where the SPA's session lives. Not readable from JavaScript — see the
 *  `httpOnly` flag in `issueSession` — so nothing in `web/` ever names it. */
const COOKIE_NAME = "bertbooker_session";

/** Domain separator for the key derivation, so this key can't collide with any
 *  other use of the same secrets. The version is load-bearing: the scheme this
 *  replaced signed with the raw password, and those tokens must not verify under
 *  the current one. Renaming the app reset it to `v1`, which is safe only
 *  because it also invalidated every session in existence — bump it, never
 *  reuse a retired value. */
const KEY_CONTEXT = "bertbooker-session-v1";

/** Deliberate cost on a wrong password. The gate is a single shared secret with
 *  no lockout, so the only thing blunting online guessing is that each attempt
 *  costs a fixed quarter-second of the attacker's wall clock. */
const BAD_PASSWORD_DELAY_MS = 250;

const encoder = new TextEncoder();

const nowSeconds = () => Math.floor(Date.now() / 1000);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare without leaking *where* two strings diverge through timing.
 *
 * Callers must pass fixed-length values (digests, signatures) — the early return
 * on length is itself a leak, and is only safe because everything compared here
 * is a hash of the same width.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await sha256(value)));
}

/**
 * Do two secrets match, without leaking how nearly?
 *
 * Both sides are hashed first so the comparison is over two fixed-width strings
 * and the length of the real secret stays hidden. Exported for `gate.test.ts`,
 * which pins that a one-character-short password does not match.
 */
export async function secretsMatch(supplied: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(supplied), sha256Hex(secret)]);
  return timingSafeEqual(a, b);
}

/**
 * The HMAC key that signs session tokens.
 *
 * HKDF-SHA256 over `SESSION_SECRET` (the keying material), salted with
 * SHA-256(`APP_PASSWORD`). Two independent things fall out of that one line:
 *
 * - The key's strength comes from `SESSION_SECRET`, which is random, so a leaked
 *   token reveals nothing about the human-chosen password.
 * - The key still *changes* when the password does, so rotating `APP_PASSWORD`
 *   remains the app's revocation mechanism — the only one a stateless,
 *   two-person session needs.
 *
 * Takes the secrets as arguments rather than a `Context` so it can be tested
 * without a worker. HKDF is microseconds; there is nothing here worth caching.
 */
export async function sessionKey(sessionSecret: string, appPassword: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: await sha256(appPassword),
      info: encoder.encode(KEY_CONTEXT),
    },
    ikm,
    256,
  );
  // Both usages on one key: `hono/jwt` hands a `CryptoKey` of type "secret"
  // straight to `crypto.subtle.sign` when minting and `verify` when checking.
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Compare a submitted password against the secret. */
async function passwordMatches(supplied: string, secret: string): Promise<boolean> {
  return secretsMatch(supplied, secret);
}

/** Mint the session JWT. `jti` makes two logins in the same second distinct;
 *  `sub` records the identity for a reader, though `auth.ts` deliberately still
 *  takes identity from `APP_USER_EMAIL` rather than from a claim. */
export async function mintToken(
  key: CryptoKey,
  expiresAt: number,
  subject: string,
): Promise<string> {
  return sign(
    { sub: subject, iat: nowSeconds(), exp: expiresAt, jti: crypto.randomUUID() },
    key,
    "HS256",
  );
}

/**
 * Verify a token and return its expiry, or null if it is malformed, expired,
 * tampered with, or signed under a different key (a rotated password, or a
 * rotated `SESSION_SECRET`).
 *
 * `hono/jwt` throws for every one of those; they are all the same answer here,
 * because the caller's only move is to ask for the password again.
 */
export async function verifyToken(
  key: CryptoKey,
  token: string | undefined,
): Promise<number | null> {
  if (!token) return null;
  try {
    const payload = await verify(token, key, "HS256");
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Which required secret, if any, is missing. Named rather than boolean because
 *  the SPA renders it as a specific misconfiguration with a specific fix, and
 *  "the app is broken" is not a fix. */
function missingSecret(env: Env): "no_app_password" | "no_session_secret" | null {
  if (!env.APP_PASSWORD) return "no_app_password";
  if (!env.SESSION_SECRET) return "no_session_secret";
  return null;
}

/** The session cookie as presented by the browser. Cookie only: the SPA has no
 *  other way to send it, so accepting a header too would just be a second door
 *  with a weaker lock — one reachable by any script on the page. */
function presentedToken(c: Context<{ Bindings: Env; Variables: Vars }>): string | undefined {
  return getCookie(c, COOKIE_NAME);
}

/**
 * Set (or clear) the session cookie.
 *
 * `Secure` is conditional because `wrangler dev` serves plain http on
 * 127.0.0.1, and a `Secure` cookie there is dropped without comment — the
 * symptom being a login that succeeds and changes nothing. Production is always
 * https, so it is always set there.
 *
 * `SameSite=Strict` is what makes CSRF a non-question for the whole API: the
 * browser will not attach this cookie to anything another site initiated. The
 * `csrf` middleware in index.ts is the belt to this pair of braces.
 *
 * In dev the browser only ever sees one origin — Vite's :5173, which proxies
 * `/api` to :8787 — so the cookie is same-site there too, with no `Domain`
 * attribute and nothing to configure.
 */
function writeSessionCookie(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  token: string | null,
): void {
  const secure = new URL(c.req.url).protocol === "https:";
  const options = { path: "/", httpOnly: true, sameSite: "Strict", secure } as const;
  if (token === null) {
    deleteCookie(c, COOKIE_NAME, options);
    return;
  }
  setCookie(c, COOKIE_NAME, token, { ...options, maxAge: SESSION_SECONDS });
}

/**
 * Gate middleware for `/api/*`.
 *
 * Runs before `identity`: there is no point upserting a user row for a caller
 * that hasn't proved it belongs here.
 *
 * There is no exception path. There was one — a local source runner presenting
 * `X-Ingest-Token` skipped straight past the session, because a headless
 * process cannot perform a login it has no UI for. Both the runner and the
 * `/api/ingest/*` endpoints it POSTed to are gone, so every caller of every
 * route below now arrives with a session cookie or does not arrive.
 */
export async function gate(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) {
  const missing = missingSecret(c.env);
  if (missing) {
    // Fail closed, and say which secret. A 401 here would send the SPA to a
    // password prompt no password can satisfy.
    return c.json({ error: missing }, 503);
  }

  const key = await sessionKey(c.env.SESSION_SECRET!, c.env.APP_PASSWORD!);
  const expiresAt = await verifyToken(key, presentedToken(c));
  if (expiresAt == null) return c.json({ error: "locked" }, 401);

  c.set("sessionExpiresAt", expiresAt);
  return next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `/api/auth/*` — the only routes outside the gate, for the obvious reason.
 *
 * They are mounted BEFORE `gate` in index.ts, because Hono runs matching
 * handlers in registration order and a handler that responds ends the chain —
 * the same trick that keeps `/api/health` open.
 */
export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * What the SPA asks on load, before it has drawn anything: is there a gate, and
 * am I already through it? Answering unauthenticated is a 200 — "you are locked
 * out" is a fact about the world, not a failure of this request.
 *
 * This is also the *only* way the SPA learns it has a session, now that the
 * cookie is invisible to it.
 */
authRoutes.get("/api/auth/session", async (c) => {
  const missing = missingSecret(c.env);
  if (missing) {
    const unconfigured: SessionState = {
      configured: false,
      reason: missing,
      authenticated: false,
      expiresAt: null,
    };
    return c.json(unconfigured);
  }
  const key = await sessionKey(c.env.SESSION_SECRET!, c.env.APP_PASSWORD!);
  const expiresAt = await verifyToken(key, presentedToken(c));
  const state: SessionState = {
    configured: true,
    authenticated: expiresAt != null,
    expiresAt,
  };
  return c.json(state);
});

/** Exchange the shared password for an 8-hour session. The token goes back as a
 *  `Set-Cookie` and nowhere else; the body carries only the expiry, which the SPA
 *  needs to know when to re-prompt. */
authRoutes.post("/api/auth/login", async (c) => {
  const missing = missingSecret(c.env);
  if (missing) return c.json({ error: missing }, 503);

  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const supplied = typeof body?.password === "string" ? body.password : "";

  if (!supplied || !(await passwordMatches(supplied, c.env.APP_PASSWORD!))) {
    await new Promise((resolve) => setTimeout(resolve, BAD_PASSWORD_DELAY_MS));
    return c.json({ error: "bad_password" }, 401);
  }

  const expiresAt = nowSeconds() + SESSION_SECONDS;
  const key = await sessionKey(c.env.SESSION_SECRET!, c.env.APP_PASSWORD!);
  writeSessionCookie(c, await mintToken(key, expiresAt, c.env.APP_USER_EMAIL ?? "unknown"));
  const result: LoginResult = { expiresAt };
  return c.json(result);
});

/**
 * Sign out. Outside the gate deliberately: a session that has already lapsed
 * still leaves a dead cookie in the jar, and refusing to clear it because it is
 * dead would be a strange sort of security.
 *
 * There is no server-side session list to invalidate — the token is stateless —
 * so this clears the cookie and that is the whole of it. Revoking a token that
 * has already been stolen still means rotating `APP_PASSWORD`, which is what the
 * key derivation is built to make possible.
 */
authRoutes.post("/api/auth/logout", (c) => {
  writeSessionCookie(c, null);
  return c.json({ ok: true });
});
