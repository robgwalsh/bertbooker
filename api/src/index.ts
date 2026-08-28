import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
// SIDE-EFFECT IMPORT, and the only one in this worker. `sources/index.ts` calls
// `registerSource(seatsAeroSource)` at module scope, which validates every
// program that source declares against `PROGRAM_SEEDS`. That matters because
// `availability_snapshots.program` is a foreign key: without this, a typo in a
// source's program list surfaces as a write failing halfway through a search
// instead of as a worker that refuses to boot.
//
// Nothing else imports a symbol from `sources/`, so this line is the whole of
// the mechanism. Deleting it as an unused import removes the check.
import "./sources/index.js";
import type { Env, Vars } from "./bindings.js";
import { identity } from "./middleware/identity.js";
import { authRoutes, gate } from "./middleware/gate.js";
import {
  applySecurityHeaders,
  corsOrigin,
  csrfOrigin,
  isEdgeRequest,
} from "./middleware/security.js";
import { runAlertTick } from "./alerts/sweep.js";
// The endpoint modules, each a `Hono` sub-app mounted below. THE ORDER OF THESE
// MOUNTS IS THE ROUTING TABLE — see the block comment above them.
import { quota } from "./endpoints/quota.js";
import { search } from "./endpoints/search.js";
import { enrich } from "./endpoints/enrich.js";
import { findHistory } from "./endpoints/findHistory.js";
import { alerts } from "./endpoints/alerts.js";
import { reference } from "./endpoints/reference.js";
import { airports } from "./endpoints/airports.js";
import { seatsaeroRoutes } from "./endpoints/seatsaeroRoutes.js";
import { routes } from "./endpoints/routes.js";
import { trackedRoutes } from "./endpoints/trackedRoutes.js";
import { settings } from "./endpoints/settings.js";

// THIS WORKER NEVER CALLS AN AIRLINE'S OWN SITE. The rule is about who is being
// scored: this Worker may call a service that authenticates the CREDENTIAL, and
// may not call one that judges the CLIENT. Carriers do the latter and refuse
// datacenter IPs outright — United answers Akamai 428 and Delta 444 to raw HTTP
// even from a residential connection, and Delta denies a real browser session
// replayed verbatim on top of that. Scraping them is over regardless; see
// docs/HARVEST-POSTMORTEM.md for why it was abandoned rather than fixed.
//
// It reaches exactly TWO hosts, and the split is the rule rather than an
// exception list:
//
//   INBOUND DATA — seats.aero's Partner API (`search/run.ts`): a keyed, metered
//     vendor API that authenticates the key rather than the client.
//   OUTBOUND NOTIFICATION — Resend (`alerts/email.ts`): not a data source at all, but a
//     delivery channel, on exactly the same keyed-vendor footing.
//
//
// Something DOES run on a schedule: the alerts cron (`alerts/sweep.ts`, and the
// `scheduled` handler on the default export below) re-searches routes marked
// for alerts. `alerts/budget.ts` reads the quota before spending, scoped to
// that one caller — see docs/ALERTS.md §1 and §7.

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Deployed the SPA is same-origin
app.use(
  "/api/*",
  cors({
    origin: corsOrigin,
    credentials: true,
    allowHeaders: ["Content-Type"],
  }),
);

// Belt to SameSite=Strict's braces. This only inspects requests a *form* could
// have made — the ones simple-CORS lets through without a preflight — so the
// SPA's JSON POSTs pass untouched, and the gap it closes is a form on someone
// else's page aimed at this API.
app.use("/api/*", csrf({ origin: csrfOrigin }));

app.get("/api/health", (c) => c.json({ ok: true, service: "bertbooker" }));

// The password gate's own routes, registered before the gate itself: Hono runs
// matching handlers in registration order and stops at the first that responds,
// so these (like /api/health above) never reach the middleware below.
app.route("/", authRoutes);

// Everything below requires the shared password.
app.use("/api/*", gate);

// ...and then an identity.
app.use("/api/*", identity);

// ---------------------------------------------------------------------------
// THE ENDPOINT MOUNTS. Everything below has passed the gate and has an identity.
//
// **This order is the routing table.** Hono runs matching handlers in
// REGISTRATION order and stops at the first that responds, so a module mounted
// earlier wins a path both could serve. The one that matters concretely:
// `search` and `enrich` own `POST /api/tracked-routes/:id/search` and
// `/enrich`, and are mounted ahead of `trackedRoutes`, which owns
// `PATCH`/`DELETE /api/tracked-routes/:id`. Reordering these is a routing
// change, not a tidy-up.
//
// Each module is a `Hono` sub-app registering ABSOLUTE `/api/...` paths, so
// every mount is at `"/"` and the paths are greppable from the handler.
// ---------------------------------------------------------------------------

// The metered sources' remaining daily allowance — what the app-bar chip reads.
// A plain read, covered by the password gate like any other.
app.route("/", quota);

// Searching a tracked route against seats.aero, streamed. Also after `identity`:
// a search is scoped to the caller's own routes and spends the shared API key.
app.route("/", search);

// Buying the itinerary behind a summary find, one seats.aero call at a time.
// Registered here purely so it reads next to `search`.
app.route("/", enrich);

// What one slot has cost over time. A pure read of `price_history` — it spends
// nothing — mounted next to `enrich` so the two `/api/finds/*` surfaces read
// together. It shares no path with anything, so this position is legibility
// rather than routing.
app.route("/", findHistory);

// What the Alerts tab reads. In production it is read-only: the cron does the
// writing, and the only way to change what it does is to edit a route (PATCH
// via `trackedRoutes` below). The one exception is `POST /api/alerts/run`, which
// 404s off a loopback host — it is the development loop for `alerts/`, and it
// calls the same `runAlertTick` the cron does rather than a second
// implementation of a tick. See docs/ALERTS.md §9.
app.route("/", alerts);

// Reference constants and the editable `programs` table.
app.route("/", reference);

// The ~72k-row OurAirports table: the Library pane, the autocompletes, and the
// coordinates the trip list's route maps draw from.
app.route("/", airports);

// The seats.aero route graph behind the Library's seats.aero pane: which pairs
// each program is monitored on. Owns `/api/seatsaero/*`, which collides with
// nothing, so this position is for reading order only — it sits beside
// `airports` because both are reference data the Library browses.
app.route("/", seatsaeroRoutes);

// The Routes page's payload — monitors joined to their current finds. The only
// reader of `findsCte`.
app.route("/", routes);

// The saved searches themselves. Mounted last of the `/api/tracked-routes`
// owners, deliberately; see the order note above.
app.route("/", trackedRoutes);

// The deployment's own settings — today, the alert-recipient allowlist. Owns
// `/api/settings/*` alone, so its position here is free.
app.route("/", settings);

/*
 * `POST /api/tracked-routes/:id/search` lives in `endpoints/search.ts`.
 *
 * A Worker cannot read a carrier's own site: United returns Akamai 428 and
 * Delta 444 even from a residential IP — see docs/HARVEST-POSTMORTEM.md.
 *
 * What the Worker does run rests on a different fact: seats.aero is a keyed
 * vendor API, not a carrier site, and does not care where the request
 * originates. So a tracked route is something the server can execute.
 */


/**
 * Everything above is the API. Everything else this worker answers is the SPA,
 * served from the `ASSETS` binding (`web/dist`, see wrangler.toml) — one worker,
 * one origin, which is what lets `app/src/api/` keep fetching relative
 * `/api/…` paths with no base URL and no CORS in production.
 *
 * **`export default app` does NOT work here, and the failure is quiet.** Static
 * assets are matched before this worker runs, so a request for `/library`
 * matches no file and arrives *here* — where Hono, having no such route, answers
 * its own 404 and the deep link breaks while the app itself looks fine. Handing
 * the request to `env.ASSETS.fetch()` is what applies
 * `not_found_handling = "single-page-application"` and returns index.html.
 * randyleague shipped this bug first (commit e6b9801, "fix spa 404s").
 *
 * `scheduled` is a SIBLING KEY on this same object, and it shares none of the
 * above: no Hono, no middleware, no `applySecurityHeaders` — see its own
 * docblock. Adding a handler here is adding a key, not wrapping `fetch`.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Canonical ORIGIN — the apex host, over https. Two corrections behind one
    // redirect, because they are the same correction: a session is an HttpOnly
    // SameSite=Strict cookie scoped to the scheme AND host that set it, so every
    // spelling this worker answers on is an independent login.
    //
    // Both `bertbooker.com` and `www.bertbooker.com` are routed here
    // (wrangler.toml) so that either resolves, but only the apex is ever SERVED.
    //
    // The https half closes a window HSTS structurally cannot: `Strict-Transport-
    // Security` is only sent on an https response (security.ts), so it does
    // nothing for a browser's FIRST plaintext request — and on this app that is
    // the request carrying the shared password. Without this, a plaintext hit on
    // the apex reached the worker, the password arrived in the clear, and the
    // session cookie went back without `Secure` (see `writeSessionCookie`).
    // Dev is exempt: `wrangler dev` serves plain http and there is nothing to
    // upgrade to. The exemption is keyed on `isEdgeRequest` rather than on the
    // URL because wrangler dev presents the PRODUCTION host over http — a
    // URL-based test makes local dev an infinite redirect to itself.
    //
    // 308 rather than 301 — permanent either way, but 308 forbids the
    // method-rewrite-to-GET that 301 historically permits, so the POST that lands
    // here replays as a POST instead of silently becoming a GET and losing the
    // body.
    let canonical: URL | null = null;
    const upgradeScheme = url.protocol !== "https:" && isEdgeRequest(request);
    if (url.hostname.startsWith("www.") || upgradeScheme) {
      canonical = new URL(url);
      if (canonical.hostname.startsWith("www.")) {
        canonical.hostname = canonical.hostname.slice(4);
      }
      if (upgradeScheme) canonical.protocol = "https:";
    }

    // Security headers are applied HERE rather than as Hono middleware, and the
    // difference matters: Hono only sees `/api/*`, so middleware would stamp the
    // JSON and miss the HTML document — the one response a CSP is actually
    // about. Every branch below goes through the same helper.
    const respond = async (): Promise<Response> => {
      // Before anything else, including the API: nothing is answered on a
      // non-canonical origin. It goes through `respond` rather than returning
      // early so the redirect carries the same headers as everything else —
      // notably HSTS, which is the one header that has to reach a browser on
      // its FIRST visit to `www.` (or to `http://`) to be worth anything.
      if (canonical) return Response.redirect(canonical.toString(), 308);

      if (pathname.startsWith("/api/")) return app.fetch(request, env, ctx);

      return env.ASSETS.fetch(request);
    };

    return applySecurityHeaders(await respond(), url);
  },

  /**
   * The cron tick — the only unattended work in this app. See docs/ALERTS.md.
   *
   * **No middleware runs here.** Not `cors`, not `csrf`, not `gate`, not
   * `identity`, and not `applySecurityHeaders` — none of those are on a code
   * path a `scheduled` invocation takes. So identity is read straight off
   * `env.APP_USER_EMAIL`, and `runAlertTick` fails closed when it is unset
   * exactly as the gate would, because `search_runs.user_email` is NOT NULL and
   * there would be no account to attribute a sweep to.
   *
   * `await`, deliberately, and NOT `ctx.waitUntil`. An async `scheduled`
   * handler's returned promise is already awaited by the runtime, so
   * `waitUntil` buys nothing — while awaiting is what makes a thrown tick show
   * up as a FAILED invocation in Workers Logs. That matters more here than
   * anywhere else in this worker: no email is ever sent about a failed sweep, so
   * the logs and the Alerts tab are the only two places a broken scheduler is
   * visible at all.
   */
  async scheduled(_controller, env, _ctx) {
    await runAlertTick(env);
  },
} satisfies ExportedHandler<Env>;
