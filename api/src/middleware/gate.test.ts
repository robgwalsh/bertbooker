import { describe, expect, it } from "vitest";
import { authRoutes, mintToken, secretsMatch, sessionKey, verifyToken } from "./gate.js";
import type { Env } from "../bindings.js";

/**
 * The session token, at the layer where it can be tested without a worker.
 *
 * These are the first tests in `api`, and they are here rather than
 * anywhere else because the properties below are the *reason* the gate was
 * rewritten — and every one of them fails silently. A token signed with the
 * wrong key still looks like a token; a key that stopped depending on the
 * password still signs and verifies perfectly, while quietly having lost the
 * only revocation this app has.
 */

const SECRET = "PxkVQ4vJm-2p1sTZ9c8LRfN0aYbWgHdE6uKoIn7XqMs";
const PASSWORD = "correct horse battery staple";
const SUBJECT = "someone@example.com";

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

describe("sessionKey / mintToken / verifyToken", () => {
  it("round-trips a token and returns its expiry", async () => {
    const key = await sessionKey(SECRET, PASSWORD);
    const exp = inAnHour();
    expect(await verifyToken(key, await mintToken(key, exp, SUBJECT))).toBe(exp);
  });

  it("refuses an expired token", async () => {
    const key = await sessionKey(SECRET, PASSWORD);
    const expired = Math.floor(Date.now() / 1000) - 1;
    expect(await verifyToken(key, await mintToken(key, expired, SUBJECT))).toBeNull();
  });

  it("refuses a token minted under a different SESSION_SECRET", async () => {
    const minted = await mintToken(await sessionKey(SECRET, PASSWORD), inAnHour(), SUBJECT);
    const other = await sessionKey(`${SECRET}-rotated`, PASSWORD);
    expect(await verifyToken(other, minted)).toBeNull();
  });

  it("refuses a token minted under a different APP_PASSWORD", async () => {
    // The revocation mechanism, and the one property that disappears without a
    // sound if someone later drops the password out of the HKDF salt: rotating
    // APP_PASSWORD must invalidate every live session. Nothing else in this app
    // can sign a user out.
    const minted = await mintToken(await sessionKey(SECRET, PASSWORD), inAnHour(), SUBJECT);
    const rotated = await sessionKey(SECRET, "a different password");
    expect(await verifyToken(rotated, minted)).toBeNull();
  });

  it("refuses a tampered payload", async () => {
    const key = await sessionKey(SECRET, PASSWORD);
    const token = await mintToken(key, inAnHour(), SUBJECT);
    const [header, payload, signature] = token.split(".");

    // Re-encode the payload with an expiry a century out, keeping the original
    // signature — the forgery anyone attempting this would actually try.
    const decoded = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
    const forged = btoa(JSON.stringify({ ...decoded, exp: decoded.exp + 100 * 365 * 86400 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyToken(key, `${header}.${forged}.${signature}`)).toBeNull();
  });

  it("refuses junk and nothing", async () => {
    const key = await sessionKey(SECRET, PASSWORD);
    expect(await verifyToken(key, undefined)).toBeNull();
    expect(await verifyToken(key, "")).toBeNull();
    expect(await verifyToken(key, "not-a-token")).toBeNull();
    // The pre-rewrite format: `<expiry>.<HMAC>`, signed with the password
    // itself. Two segments, so it isn't even a JWT — and must not verify.
    expect(await verifyToken(key, `${inAnHour()}.SGVsbG8gdGhlcmU`)).toBeNull();
  });

  it("derives the same key twice", async () => {
    // HKDF is deterministic, so a token minted in one isolate verifies in the
    // next. Nothing about the session is stored, and this is why that works.
    const minted = await mintToken(await sessionKey(SECRET, PASSWORD), inAnHour(), SUBJECT);
    expect(await verifyToken(await sessionKey(SECRET, PASSWORD), minted)).not.toBeNull();
  });
});

describe("secretsMatch", () => {
  it("accepts the right secret and rejects the rest", async () => {
    expect(await secretsMatch(PASSWORD, PASSWORD)).toBe(true);
    expect(await secretsMatch("wrong", PASSWORD)).toBe(false);
    expect(await secretsMatch("", PASSWORD)).toBe(false);
    // A prefix must not pass. The comparison is over two same-width digests
    // precisely so the length of the real secret never leaks.
    expect(await secretsMatch(PASSWORD.slice(0, -1), PASSWORD)).toBe(false);
  });
});

/**
 * The login route itself, driven through Hono rather than through its parts.
 *
 * The two properties below are both about things that happen AROUND the
 * comparison, which is why testing `secretsMatch` alone never covered them: a
 * cookie missing `Secure` verifies exactly like one that has it, and a missing
 * throttle looks identical to a working one until someone is actually guessing.
 */

/** The bindings a login needs, plus whatever the test is varying. */
const loginEnv = (over: Partial<Env> = {}): Env =>
  ({
    APP_PASSWORD: PASSWORD,
    SESSION_SECRET: SECRET,
    APP_USER_EMAIL: SUBJECT,
    ...over,
  }) as Env;

/**
 * A login request. `edgeIp` is what makes it PRODUCTION: `CF-Connecting-IP` is
 * stamped by Cloudflare's edge on every proxied request and is absent under
 * `wrangler dev`, which is the only reliable way to tell the two apart — the
 * URL is not, because wrangler dev presents the production host over http (see
 * `isEdgeRequest`).
 */
const postLogin = (url: string, password: string, env: Env, edgeIp?: string) =>
  authRoutes.request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(edgeIp ? { "CF-Connecting-IP": edgeIp } : {}),
      },
      body: JSON.stringify({ password }),
    },
    env,
  );

describe("POST /api/auth/login — the session cookie", () => {
  it("marks the cookie Secure in production", async () => {
    const res = await postLogin(
      "https://bertbooker.com/api/auth/login",
      PASSWORD,
      loginEnv(),
      "203.0.113.7",
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  /**
   * The regression this is really about.
   */
  it("still marks it Secure on a PLAINTEXT production request", async () => {
    const res = await postLogin(
      "http://bertbooker.com/api/auth/login",
      PASSWORD,
      loginEnv(),
      "203.0.113.7",
    );
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/);
  });

  /**
   * The reason the flag is conditional at all: `wrangler dev` serves plain http
   * and a browser drops a `Secure` cookie there without comment, which reads as
   * a login that succeeds and changes nothing.
   *
   * Note the URL: `wrangler dev` really does present the production host, so
   * this case is NOT distinguishable from the one above by URL. That is the
   * whole reason `isEdgeRequest` exists.
   */
  it("omits Secure under wrangler dev, so local login still works", async () => {
    const res = await postLogin("http://bertbooker.com/api/auth/login", PASSWORD, loginEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/Secure/);
  });
});

describe("POST /api/auth/login — the throttle", () => {
  /** A limiter that refuses everything, and counts what it was asked. */
  const refusing = () => {
    const keys: string[] = [];
    return {
      keys,
      limiter: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      } as RateLimit,
    };
  };

  it("refuses with 429 before comparing anything", async () => {
    const { keys, limiter } = refusing();
    const res = await postLogin(
      "https://bertbooker.com/api/auth/login",
      // The CORRECT password: a throttled request must be refused on the
      // throttle, not quietly let through because it happened to be right.
      PASSWORD,
      loginEnv({ LOGIN_LIMITER: limiter }),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_attempts" });
    // ...and no session was issued.
    expect(res.headers.get("set-cookie")).toBeNull();
    // No edge header on this one, so every unproxied caller shares one bucket
    // rather than skipping the check.
    expect(keys).toEqual(["login:unproxied"]);
  });

  it("keys on the edge-supplied client IP", async () => {
    const { keys, limiter } = refusing();
    await authRoutes.request(
      "https://bertbooker.com/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ password: "wrong" }),
      },
      loginEnv({ LOGIN_LIMITER: limiter }),
    );
    expect(keys).toEqual(["login:203.0.113.7"]);
  });

  /**
   * The one binding here that deliberately does NOT fail closed. Every other
   * unset value refuses requests, because a missing gate is worse than a broken
   * app; this one is the gate's own throttle, and refusing every login when it
   * is absent would lock the account out of its own app over a config detail.
   */
  it("lets a login through when no limiter is bound", async () => {
    const res = await postLogin(
      "https://bertbooker.com/api/auth/login",
      PASSWORD,
      loginEnv(),
      "203.0.113.7",
    );
    expect(res.status).toBe(200);
  });

  it("still fails closed on the secrets, which are a different question", async () => {
    const res = await postLogin(
      "https://bertbooker.com/api/auth/login",
      PASSWORD,
      loginEnv({ APP_PASSWORD: undefined }),
      "203.0.113.7",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_app_password" });
  });
});
