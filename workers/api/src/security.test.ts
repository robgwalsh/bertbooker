import { describe, expect, it } from "vitest";
import { isLocalRequest } from "./security.js";

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
