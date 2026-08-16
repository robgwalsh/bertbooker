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
  origin === new URL(c.req.url).origin || origin === DEV_ORIGIN;

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
 * True when this worker is answering on a loopback host — i.e. `wrangler dev`,
 * reached directly or through the Vite proxy.
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
  // *.basemaps.cartocdn.com — the airports map's dark tiles (app/src/pages/library/airports/AirportMap.tsx)
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
