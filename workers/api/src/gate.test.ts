import { describe, expect, it } from "vitest";
import { mintToken, secretsMatch, sessionKey, verifyToken } from "./gate.js";

/**
 * The session token, at the layer where it can be tested without a worker.
 *
 * These are the first tests in `workers/api`, and they are here rather than
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
