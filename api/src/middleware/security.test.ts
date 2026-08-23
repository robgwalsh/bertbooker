import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { corsOrigin, csrfOrigin, isEdgeRequest, isLocalRequest } from "./security.js";

/**
 * The dev-vs-production discriminator, at the layer where it can be tested
 * without a worker.
 *
 * This predicate is the only thing standing between `POST /api/alerts/run` and
 * production, and it fails in the quiet direction: a version that returned
 * `true` too often would publish a button that spends metered seats.aero calls,
 * and nothing about the response would look wrong. Hence a test per host shape
 * this worker actually answers on.
 */

describe("isEdgeRequest", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://bertbooker.com/api/routes", { headers });

  it("is true only when the edge stamped a client IP", () => {
    expect(isEdgeRequest(req({ "CF-Connecting-IP": "203.0.113.7" }))).toBe(true);
    expect(isEdgeRequest(req({}))).toBe(false);
  });

  /**
   * The property the whole predicate rests on: under `wrangler dev` the URL is
   * the PRODUCTION host over http, so nothing about it can tell dev from
   * production. A `Secure` cookie or an https redirect decided on the URL is
   * therefore wrong in local dev — the first silently drops the session, the
   * second is an infinite redirect loop. Both were shipped and caught by
   * running the thing.
   */
  it("does not consult the URL, which lies in dev", () => {
    const devLooking = new Request("http://bertbooker.com/api/routes");
    const prodLooking = new Request("https://bertbooker.com/api/routes");
    expect(isEdgeRequest(devLooking)).toBe(false);
    expect(isEdgeRequest(prodLooking)).toBe(false);
    // `isLocalRequest` agrees with neither, which is precisely the trap.
    expect(isLocalRequest("http://bertbooker.com/api/routes")).toBe(false);
  });
});

describe("isLocalRequest", () => {
  it("accepts the wrangler dev host", () => {
    expect(isLocalRequest("http://127.0.0.1:8787/api/alerts/run")).toBe(true);
  });

  // Vite does not rewrite Host by default, so a proxied /api call reaches the
  // worker still claiming :5173. Both spellings have to pass or the button
  // renders in dev and 404s when clicked.
  it("accepts the Vite dev host, which the proxy passes through unchanged", () => {
    expect(isLocalRequest("http://localhost:5173/api/alerts/run")).toBe(true);
  });

  it("accepts IPv6 loopback in both spellings", () => {
    expect(isLocalRequest("http://[::1]:8787/api/alerts/run")).toBe(true);
  });

  it("refuses the production custom domain", () => {
    expect(isLocalRequest("https://bertbooker.com/api/alerts/run")).toBe(false);
  });

  // `workers_dev = true`, so this host is real and is NOT dev in any sense that
  // matters — it is the deployed worker under a different name.
  it("refuses the workers.dev host", () => {
    expect(isLocalRequest("https://bertbooker.example.workers.dev/api/alerts/run")).toBe(false);
  });

  it("is not fooled by a hostname that merely contains 'localhost'", () => {
    expect(isLocalRequest("https://localhost.example.com/api/alerts/run")).toBe(false);
    expect(isLocalRequest("https://notlocalhost/api/alerts/run")).toBe(false);
  });
});

/**
 * Who may talk to this worker cross-origin.
 *
 * `corsOrigin` and `csrfOrigin` are one predicate behind two shapes, and the
 * value it returns is echoed into `Access-Control-Allow-Origin` alongside
 * `Access-Control-Allow-Credentials: true` (index.ts). So a `true` too many is
 * not a lax header — it is a standing invitation to send credentialed requests
 * to this API from a page this app has never heard of.
 *
 * The dev origin used to be allowed unconditionally, on every host. Nothing was
 * exploitable, because `SameSite=Strict` kept the cookie off the request — but
 * that is one cookie attribute standing between a grant and a session, and the
 * grant bought production nothing. These pin that it is gone.
 */
/**
 * A context on the given origin. `edge` is what marks it PRODUCTION — the URL
 * cannot, because `wrangler dev` presents the production host (see
 * `isEdgeRequest`), which is exactly the trap this predicate was rewritten to
 * avoid.
 */
const ctx = (url: string, edge = true) =>
  ({
    req: {
      url,
      raw: new Request(url, { headers: edge ? { "CF-Connecting-IP": "203.0.113.7" } : {} }),
    },
  }) as Context;

describe("corsOrigin", () => {
  it("allows the origin the worker is itself answering on", () => {
    expect(corsOrigin("https://bertbooker.com", ctx("https://bertbooker.com/api/routes"))).toBe(
      "https://bertbooker.com",
    );
    // `workers_dev = true`, so this is a second real origin and same-origin
    // there has to keep working. Computed from the request, never hardcoded.
    expect(
      corsOrigin(
        "https://bertbooker.example.workers.dev",
        ctx("https://bertbooker.example.workers.dev/api/routes"),
      ),
    ).toBe("https://bertbooker.example.workers.dev");
  });

  it("REFUSES the Vite dev origin in production", () => {
    expect(corsOrigin("http://localhost:5173", ctx("https://bertbooker.com/api/routes"))).toBeNull();
    expect(
      csrfOrigin("http://localhost:5173", ctx("https://bertbooker.com/api/tracked-routes")),
    ).toBe(false);
  });

  it("still allows it when nothing proxied the request, which is what dev is", () => {
    // Note the URL is the production host: that is genuinely what `wrangler dev`
    // hands the worker, and the absence of the edge header is the only thing
    // separating this case from the one above.
    expect(
      corsOrigin("http://localhost:5173", ctx("http://bertbooker.com/api/routes", false)),
    ).toBe("http://localhost:5173");
    expect(
      csrfOrigin("http://localhost:5173", ctx("http://bertbooker.com/api/routes", false)),
    ).toBe(true);
  });

  it("refuses everything else", () => {
    expect(corsOrigin("https://evil.example", ctx("https://bertbooker.com/api/routes"))).toBeNull();
    // A near-miss on the real host, which is the shape an attacker actually
    // registers.
    expect(
      corsOrigin("https://bertbooker.com.evil.example", ctx("https://bertbooker.com/api/routes")),
    ).toBeNull();
    // Right host, wrong scheme: still a different origin.
    expect(corsOrigin("http://bertbooker.com", ctx("https://bertbooker.com/api/routes"))).toBeNull();
  });
});
