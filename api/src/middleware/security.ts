import type { Context } from "hono";

/**
 * Transport-level hardening: who may talk to this worker cross-origin, and what
 * a browser is allowed to do with what it sends back.
 *
 * None of this is the gate — `gate.ts` decides whether a caller is allowed in at
 * all. This file is about the layer under that: the session credential now lives
 * in an `HttpOnly` cookie, and a cookie is only as good as the rules around it.
 * A wildcard CORS policy, a missing `frame-ancestors`, or a page that can load
 * script from anywhere all hand an attacker the credential without ever having
 * to guess the password.
 */

/** The Vite dev server. In dev the browser only ever sees THIS origin — `/api`
 *  is proxied to :8787 (`web/vite.config.ts`), which is what makes a
 *  same-site cookie work across two processes. */
const DEV_ORIGIN = "http://localhost:5173";

/**
 * Same-origin under whatever host this worker is answering on, plus the dev
 * server.
 *
 * Deliberately computed from `c.req.url` rather than hardcoded: this worker
 * answers on the custom domain *and* on `bertbooker.<subdomain>.workers.dev`
 * (`workers_dev = true` in wrangler.toml), and a hardcoded list would silently
 * break the second one — as a 403 on every POST, which reads like a bug in the
 * app rather than a policy.
 */
const originAllowed = (origin: string, c: Context): boolean =>
  origin === new URL(c.req.url).origin ||
  // The dev server, and ONLY while this worker is itself answering on loopback.
  //
  // Unconditionally — which is how this read first — it was a standing
  // cross-origin credential grant in production. `cors` is mounted with
  // `credentials: true` (index.ts), so bertbooker.com echoed
  // `Access-Control-Allow-Origin: http://localhost:5173` together with
  // `Allow-Credentials: true` to any page a victim happened to be serving on
  // Vite's default port, and `csrfOrigin` — the same predicate — accepted that
  // origin for form-shaped writes. `SameSite=Strict` meant the session cookie
  // never actually rode along, so nothing was exploitable; but that is one
  // cookie attribute standing between a grant and a session, and the grant buys
  // production nothing at all. Gating it costs dev nothing, because dev is
  // exactly where the request URL IS loopback.
  //
  // Keyed on `isEdgeRequest`, not on the URL: under `wrangler dev` the URL
  // claims to be production (see that function), so a URL-based test would
  // refuse the Vite origin in the one place it is meant to work.
  (!isEdgeRequest(c.req.raw) && origin === DEV_ORIGIN);

/**
 * The same rule in the two shapes Hono's middlewares want — `cors` echoes back
 * the string it is given, `csrf` wants a boolean. One predicate behind both on
 * purpose: two allowlists answering one question is one allowlist and one
 * liability.
 */
export const corsOrigin = (origin: string, c: Context): string | null =>
  originAllowed(origin, c) ? origin : null;

export const csrfOrigin = originAllowed;

/**
 * Is this request being served through Cloudflare's edge — i.e. is this
 * production?
 *
 * **NOT the same question as `isLocalRequest` below, and the difference is not
 * academic.** Under `wrangler dev`, an uncommented `[[routes]] custom_domain`
 * entry in wrangler.toml makes the worker see `request.url` as
 * `http://bertbooker.com/…`: the PRODUCTION host, over http. So every
 * URL-derived "am I local?" test answers no in local dev, and every "am I
 * deployed?" test answers yes. Anything that gates real behaviour on the URL is
 * therefore wrong in dev in whichever direction hurts most — a plaintext-to-https
 * redirect built on `isLocalRequest` turns local dev into an infinite redirect
 * loop, and a `Secure` cookie built on it is dropped by the browser, which reads
 * as a login that succeeds and changes nothing.
 *
 * `CF-Connecting-IP` is stamped by the edge on every proxied request and cannot
 * be forged — a client header of that name is overwritten before the worker
 * runs, which is also why the login throttle keys on it. Its absence means
 * nothing proxied this request, and off a real deployment that means
 * `wrangler dev`.
 *
 * Fails toward PRODUCTION: anything genuinely edge-served gets the strict
 * behaviour, and the worst a missing header can do is relax dev.
 */
export function isEdgeRequest(req: Request): boolean {
  return req.headers.get("CF-Connecting-IP") !== null;
}

/**
 * True when this worker is answering on a loopback host.
 *
 * **Read `isEdgeRequest` above before reaching for this.** It does what it says
 * — it tests the URL — but the URL is not a reliable dev/production
 * discriminator under `wrangler dev`, so this answers `false` in local dev
 * whenever a `custom_domain` route is configured. That is why the endpoints
 * gated on it below (`/api/airports/countries`, `/api/airports/geo`,
 * `POST /api/alerts/run`) answer 404 in local dev while a route block is
 * uncommented. Those are dev-only conveniences and this errs toward refusing,
 * so it is a wrinkle rather than a hole — but it is why nothing that must be
 * CORRECT in both environments should be built on it.
 *
 * The codebase's one dev-vs-production discriminator, and it lives here because
 * "where did this request come from" is what the rest of this file answers.
 * There are no `[env.*]` blocks in wrangler.toml to hang a flag on, and a
 * `.dev.vars` entry would be a fifth line in a file whose four are documented —
 * one more thing to remember to set and to forget to unset.
 *
 * It reads the `Host` header by way of `c.req.url`, so on its own it is not a
 * security boundary: Cloudflare routes by zone and route pattern, so a request
 * carrying `Host: localhost` never arrives here in production, and anything
 * gated on this sits behind `gate` regardless. It decides what a *developer* can
 * reach, not who is allowed in.
 */
export function isLocalRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Everything the SPA loads from somewhere that isn't this worker. Each entry has
 *  exactly one call site, named, because an allowance nobody can trace is an
 *  allowance nobody will ever remove. */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // The API is same-origin. Nothing in the SPA calls out — the one outbound
  // vendor call (seats.aero) is made by the worker, never by the browser.
  "connect-src 'self'",
  // No inline script, no eval: the bundle is the only script that runs, which is
  // what makes this line the actual mitigation for a stolen session cookie.
  "script-src 'self'",
  // MUI/Emotion inject <style> tags and Leaflet writes inline transforms, so
  // 'unsafe-inline' here is not optional. fonts.googleapis.com is the Inter
  // stylesheet in web/index.html.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // images.kiwi.com — carrier logos (app/src/lib/flights.ts)
  // icons.duckduckgo.com — program/site icons (app/src/lib/currencies.ts)
  // *.basemaps.cartocdn.com — the basemap tiles under the Airports pane's
  //   Leaflet map, and only that one (app/src/components/leafletChrome.tsx).
  //   The seats.aero pane's route graph draws a vector basemap compiled into
  //   the bundle, so it reaches no tile server at all.
  "img-src 'self' data: blob: https://images.kiwi.com https://icons.duckduckgo.com https://*.basemaps.cartocdn.com",
].join("; ");

/**
 * Stamp the security headers onto a response.
 *
 * Called from the default export in index.ts for **both** branches — the Hono
 * API and `env.ASSETS.fetch()`. Doing it as Hono middleware instead would cover
 * the JSON and miss the HTML document, which is the one response a CSP is
 * actually about.
 *
 * Responses that came back from a `fetch` (the ASSETS binding) carry immutable
 * headers, hence the copy.
 */
export function applySecurityHeaders(res: Response, url: URL): Response {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  // Only over https. Sending HSTS from `wrangler dev` would pin *localhost* to
  // HTTPS in the developer's browser — for every project on that machine, for a
  // year, with no obvious way to connect the symptom to this line.
  if (url.protocol === "https:") {
    out.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return out;
}
