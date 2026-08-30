import type { Context, Next } from "hono";
import type { Env, Vars } from "../bindings.js";

/**
 * Identity middleware, and it is deliberately not an authentication one — that
 * is `gate.ts`, which has already run by the time we get here.
 *
 * There is **one identity**, `APP_USER_EMAIL`, shared by everyone who knows the
 * password. That is the whole model: a single shared account, one set of tracked
 * routes, no per-person login. `gate` decides who gets in; this only says who
 * they are, and the answer is always the same.
 *
 * **`Cf-Access-Authenticated-User-Email` is deliberately NOT read.** Nothing
 * here verifies an Access JWT, and an unverified header is just a string the
 * client chose — so honouring it would let anyone past the gate claim any
 * identity they liked.
 *
 * No table backs this and no row is written. Because there is one identity, no
 * row could ever scope anything: the email is a value the alert digest is
 * addressed to, not a key that owns data. So the only thing left to do is fail
 * closed when it is unset, which is what this does — and it touches the database
 * not at all.
 */
export async function identity(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
) {
  const email = c.env.APP_USER_EMAIL;
  if (!email) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  c.set("userEmail", email);
  await next();
}
