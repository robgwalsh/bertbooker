import type { Context, Next } from "hono";
import type { Env, Vars } from "./bindings.js";

/**
 * Identity middleware, and it is deliberately not an authentication one — that
 * is `gate.ts`, which has already run by the time we get here.
 *
 * There is **one identity**, `APP_USER_EMAIL`, shared by everyone who knows the
 * password. That is the whole model: a single shared account, one set of tracked
 * routes, no per-person login. `gate` decides who gets in; this decides only
 * whose rows they are, and the answer is always the same rows.
 *
 * **`Cf-Access-Authenticated-User-Email` is deliberately NOT read.** It used to
 * be, back when Cloudflare Access fronted this worker and the header could only
 * have come from Access. Access is gone, nothing here verifies an Access JWT,
 * and an unverified header is just a string the client chose — so honouring it
 * would let anyone past the gate claim any identity they liked. Reinstating it
 * means reinstating Access *and* verifying the JWT, not deleting this comment.
 *
 * On first sight of an email we upsert a `users` row so foreign keys hold.
 */
export async function identity(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
) {
  const email = c.env.APP_USER_EMAIL;
  if (!email) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  await c.env.DB.prepare(
    "INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email)
    .run();

  c.set("userEmail", email);
  await next();
}
