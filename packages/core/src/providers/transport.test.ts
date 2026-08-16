import { describe, expect, it } from "vitest";
import { BlockedError, detectBlock, makeTransport, type FetchLike } from "./transport.js";

// Block detection is the highest-stakes pure function in the gather stack: a
// false negative parses a challenge page as award data, a false positive makes a
// working source report itself broken. The markers below are the ones actually
// observed in captured `-blocked.json` fixtures.

describe("detectBlock", () => {
  it("flags the usual denial codes", () => {
    for (const status of [401, 403, 429, 451, 503]) {
      expect(detectBlock(status, "application/json", "{}").blocked).toBe(true);
    }
  });

  it("flags Akamai's 428 js-challenge (what United returns)", () => {
    const signal = detectBlock(428, "text/html", "<html>...</html>");
    expect(signal.blocked).toBe(true);
    expect(signal.reason).toContain("428");
  });

  it("flags Akamai's 444 edge deny (what Delta returns) on status alone", () => {
    // Delta answers 444 on every shopping endpoint. Until this case existed it
    // was caught only by the "access denied" body marker, so an empty-bodied
    // 444 read as "the recipe is wrong" — the opposite of the truth.
    const signal = detectBlock(444, "text/html", "");
    expect(signal.blocked).toBe(true);
    expect(signal.reason).toContain("444");
  });

  it("flags a 444 even when the caller expects HTML", () => {
    // expectsJson:false passes contentType as null, which skips the HTML rule.
    // The status rules must still fire, or an SSR-page adapter would parse a
    // denial as an empty result set — "no award space" instead of "blocked".
    expect(detectBlock(444, null, "").blocked).toBe(true);
  });

  it("passes a normal JSON response", () => {
    expect(detectBlock(200, "application/json", '{"rows":[]}')).toEqual({ blocked: false });
  });

  it("flags HTML served where JSON was expected", () => {
    const signal = detectBlock(200, "text/html; charset=utf-8", "<!DOCTYPE html>");
    expect(signal.blocked).toBe(true);
    expect(signal.reason).toBe("html where json expected");
  });

  it("does NOT flag HTML when the caller expects HTML", () => {
    // Alaska's award payload IS html; contentType null means "don't judge it".
    expect(detectBlock(200, null, "<!DOCTYPE html><body>rows:[]</body>")).toEqual({
      blocked: false,
    });
  });

  it("flags known challenge markers in the body", () => {
    const cases: [string, string][] = [
      ["<h1>Access Denied</h1>", "access denied"],
      ["Request unsuccessful. Incapsula incident ID", "incapsula"],
      ["<div id=px-captcha>", "px-captcha"],
      ["Pardon Our Interruption", "pardon our interruption"],
      ["Akamai Reference Number: 18.abc", "akamai reference number"],
      ["please complete the captcha", "captcha"],
    ];
    for (const [body, marker] of cases) {
      const signal = detectBlock(200, "application/json", body);
      expect(signal.blocked, body).toBe(true);
      expect(signal.reason).toContain(marker);
    }
  });

  it("only inspects the head of the body", () => {
    // A legitimate 3MB payload that happens to contain the word "captcha" deep
    // inside must not be misread as a block.
    const body = "{" + "x".repeat(5000) + "captcha}";
    expect(detectBlock(200, "application/json", body).blocked).toBe(false);
  });
});

/** A scripted fetch: returns queued responses in order and records calls. */
function fakeFetch(queue: Response[]): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: no queued response");
    return next;
  };
  return Object.assign(fn, { calls });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const blockedHtml = () =>
  new Response("<h1>Access Denied</h1>", { status: 403, headers: { "content-type": "text/html" } });

describe("makeTransport", () => {
  it("passes an unblocked response straight through", async () => {
    const base = fakeFetch([json({ ok: true })]);
    const t = makeTransport({ base });

    const res = await t("https://airline.example/api", { method: "GET" });

    expect(await res.json()).toEqual({ ok: true });
    expect(base.calls).toHaveLength(1);
    expect(base.calls[0]!.url).toBe("https://airline.example/api");
  });

  it("throws BlockedError rather than handing a challenge page to a parser", async () => {
    // The whole point of classification. Returning this response would let an
    // adapter parse "Access Denied" as an empty award matrix, which reads
    // downstream as "this space is gone" and deletes real finds.
    const base = fakeFetch([blockedHtml()]);
    const t = makeTransport({ base });

    await expect(t("https://airline.example/api", { method: "GET" })).rejects.toThrow(BlockedError);
  });

  it("carries the reason and status, so a task can record `blocked` not `failed`", async () => {
    // Those two call for opposite responses: try the browser vs. fix the parser.
    const t = makeTransport({ base: fakeFetch([blockedHtml()]) });
    const err = await t("https://airline.example/api", { method: "GET" }).catch((e) => e);

    expect(err).toBeInstanceOf(BlockedError);
    expect(err.status).toBe(403);
    expect(err.reason).toContain("403");
    expect(err.url).toBe("https://airline.example/api");
  });

  it("is sticky: once refused, the rest of the fan-out never touches the network", async () => {
    // Hammering a source that has already said no is both pointless and the
    // fastest way to make the refusal permanent.
    const base = fakeFetch([blockedHtml()]);
    const t = makeTransport({ base });

    await expect(t("https://airline.example/1", { method: "GET" })).rejects.toThrow(BlockedError);
    await expect(t("https://airline.example/2", { method: "GET" })).rejects.toThrow(/sticky/);
    await expect(t("https://airline.example/3", { method: "GET" })).rejects.toThrow(/sticky/);

    expect(base.calls).toHaveLength(1);
  });

  it("strips content-encoding when rebuilding, so the body stays readable", async () => {
    // The header describes the ORIGINAL compressed bytes; carrying it onto an
    // already-decoded string body corrupts everything downstream.
    const base = fakeFetch([
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      }),
    ]);
    const t = makeTransport({ base });

    const res = await t("https://airline.example/api", { method: "GET" });

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not treat an HTML payload as a block when expectJson is false", async () => {
    const base = fakeFetch([
      new Response("<html>rows:[]</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    // Alaska's award payload IS html. Without expectJson:false the transport
    // would throw BlockedError on every good response.
    const t = makeTransport({ base, expectJson: false });

    const res = await t("https://alaskaair.example/search/results", { method: "GET" });

    expect(res.status).toBe(200);
    expect(base.calls).toHaveLength(1);
  });
});
