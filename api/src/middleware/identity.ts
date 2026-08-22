import type { Context, Next } from "hono";
import type { Env, Vars } from "../bindings.js";

/**
 * Identity middleware, and it is deliberately not an authentication one — that
 * is `gate.ts`, which has already run by the time we get here.
 *
 * There is **one identity**, `APP_USER_EMAIL`, shared by everyone who knows the
 * password. That is the whole model: a single shared account, one set of tracked
 * routes, no per-person login. `gate` decides who gets in; this decides only
 * whose rows they are, and the answer is always the same rows.
 *
 * **`Cf-Access-Authenticated-User-Email` is deliberately NOT read.** Nothing
 * here verifies an Access JWT, and an unverified header is just a string the
 * client chose — so honouring it would let anyone past the gate claim any
 * identity they liked.
 *
 * On first sight of an email we upsert a `users` row so foreign keys hold.
 */

/**
 * The email this isolate has already ensured a row for.
 *
 * The upsert below used to run on **every single `/api/*` request** — including
 * the app bar's quota poll every 60s and its alert-schedule poll every 5
 * minutes, from every open tab. It reads about one row and writes none after
 * the first time, so this was never a rows-read problem; what it cost was a D1
 * round trip in front of every request and one of the 1,000 queries an
 * invocation gets.
 *
 * Not a cache with an invalidation problem: `APP_USER_EMAIL` is fixed for the
 * life of the isolate, the row can only be created once, and only a human with
 * database access can delete it — after which a new deploy or any cold start
 * recreates it. Module scope is per-isolate, so the blast radius of being wrong
 * is one isolate until it recycles.
 */
let ensuredEmail: string | undefined;

export async function identity(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
) {
  const email = c.env.APP_USER_EMAIL;
  if (!email) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  if (ensuredEmail !== email) {
    await c.env.DB.prepare(
      "INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING",
    )
      .bind(email)
      .run();
    ensuredEmail = email;
  }

  c.set("userEmail", email);
  await next();
}
