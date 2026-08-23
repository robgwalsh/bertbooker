/** API worker bindings.
 */
export interface Env {
  DB: D1Database;
  /** The built SPA (`web/dist`), served by this same worker for every path that
   *  isn't `/api/*` — see the default export in `index.ts`. One worker, one
   *  origin, which is what lets the SPA's relative `/api/…` fetches work
   *  deployed with no base URL and no CORS. */
  ASSETS: Fetcher;
  /** The app's single identity, a `[vars]` entry — NOT a dev fallback. Entry is
   *  the shared password (`gate.ts`) and everyone who types it is this account,
   *  so `auth.ts` reads this and nothing else. Unset => 401. */
  APP_USER_EMAIL?: string;
  /** The shared password the couple types on the way in (`wrangler secret put
   *  APP_PASSWORD`; locally, a line in `api/.dev.vars`). It is compared
   *  against, and folded into the session-key derivation as a salt — so
   *  rotating it still signs everyone out — but it is NOT the signing key
   *  itself; see `SESSION_SECRET`.
   *  Unset => `gate` refuses every `/api/*` request with 503, deliberately: a
   *  gate that disappears when its secret is missing is not a gate. */
  APP_PASSWORD?: string;
  /** 32 random bytes, base64url (`wrangler secret put SESSION_SECRET`; locally,
   *  a line in `api/.dev.vars`). The input keying material for the
   *  session JWT's signing key.
   *
   *  A high-entropy key here is what keeps a leaked session token from being
   *  an offline cracking oracle on `APP_PASSWORD`: signing with the password
   *  directly would make a leaked token a known message under a human-chosen
   *  key, grindable at billions of guesses a second.
   *
   *  Unset => 503, the same fail-closed posture `APP_PASSWORD` takes. Falling
   *  back to a password-derived key would restore exactly the weakness this
   *  exists to remove, and would do it silently. */
  SESSION_SECRET?: string;
  /** Per-IP throttle on `POST /api/auth/login`, declared as `[[ratelimits]]` in
   *  wrangler.toml.
   *
   *  The one optional binding here whose absence is deliberately NOT
   *  fail-closed. Every other unset value above refuses requests, because a
   *  missing gate is worse than a broken app; this one is the gate's own
   *  throttle, and refusing every login when it is missing would lock the
   *  account out of its own app over a config detail. Absent => no throttle,
   *  which is exactly where this code started.
   *
   *  Know what it is and is not. It counts per Cloudflare LOCATION rather than
   *  globally, so it raises the cost of guessing the shared password without
   *  bounding it: an attacker spread across enough colos still gets a multiple
   *  of the limit. The control that actually bounds a distributed attack is a
   *  WAF Rate Limiting rule on this path, which lives in the dashboard and
   *  cannot be expressed in this repo at all. This binding is the half that
   *  ships with the code, and it is worth having for that reason — but it is a
   *  speed bump, not the lock. */
  LOGIN_LIMITER?: RateLimit;
  /** seats.aero Partner API key (`wrangler secret put SEATS_AERO_API_KEY`;
   *  locally, a line in `api/.dev.vars`). Unset => the search endpoint
   *  refuses with 503 rather than returning an empty result — "no key" and "no
   *  award space" must never look alike. */
  SEATS_AERO_API_KEY?: string;

  // ---- Alerts (the scheduled sweep). See docs/ALERTS.md. ----

  /** Resend API key (`wrangler secret put RESEND_API_KEY`; locally, a line in
   *  `api/.dev.vars`). Unset => sweeps still run and still ingest, but
   *  the flush records an `alert_deliveries` row with `status='skipped'` saying
   *  so. Never a silent drop: with no failure emails, that row is the only trace
   *  a missing digest leaves. */
  RESEND_API_KEY?: string;
  /** The digest's From address, on a Resend-verified domain (e.g.
   *  `alerts@example.com`). Unset behaves exactly like a missing key. */
  ALERT_FROM?: string;
  /** CSV of addresses the Worker may send to. `APP_USER_EMAIL` is always
   *  included. Unset therefore means "only the account's own address", which is
   *  the safe default rather than the permissive one — with one shared password
   *  as the only auth, an unchecked per-route `alert_email` would make this an
   *  arbitrary-recipient sender on a verified domain. */
  ALERT_ALLOWED_RECIPIENTS?: string;
  /** Calls a day the SCHEDULER may spend, against the key's 1000. Default 600.
   *  Not the same thing as the reserve below: this bounds automation's share,
   *  the reserve bounds how close anything may get to the ceiling. */
  ALERT_DAILY_BUDGET?: string;
  /** Calls that must remain unspent so a human pressing Search always gets an
   *  answer. Default 300. This is the number the guard actually exists for. */
  ALERT_MANUAL_RESERVE?: string;
  /** Calls one cron tick may spend before pausing the route to the next tick.
   *  Default 25. A Cron Trigger under an hour gets 30 SECONDS of CPU, and
   *  parsing a page of 500 trips-bearing rows is the CPU in question — so a tick
   *  is deliberately small and resumes through the same `run_continue`
   *  mechanism the HTTP search uses. */
  ALERT_MAX_CALLS_PER_TICK?: string;
  /** Absolute base URL for links in the digest, e.g.
   *  `https://example.com`. Unset omits the link. */
  APP_URL?: string;
}

/** Hono context variables set by middleware. */
export interface Vars {
  userEmail: string;
  /** Epoch seconds at which the caller's password session lapses, set by `gate`.
   *  Optional because `scheduled()` runs no middleware at all. */
  sessionExpiresAt?: number;
}
