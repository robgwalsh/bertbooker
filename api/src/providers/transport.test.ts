import { describe, expect, it } from "vitest";
import { BlockedError, detectBlock, makeTransport, type FetchLike } from "./transport.js";

// Block detection is the highest-stakes pure function in the gather stack: a
// false negative parses a refusal as award data, a false positive makes a
// working call report itself broken.

describe("detectBlock", () => {
  it("flags the usual denial codes", () => {
    for (const status of [401, 403, 429, 451, 503]) {
      expect(detectBlock(status).blocked).toBe(true);
    }
  });

  it("passes a normal 200", () => {
    expect(detectBlock(200)).toEqual({ blocked: false });
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

const blockedResponse = () =>
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

  it("throws BlockedError rather than handing a refusal to a parser", async () => {
    // The whole point of classification. Returning this response would let a
    // caller parse "Access Denied" as an empty award matrix, which reads
    // downstream as "this space is gone" and deletes real finds.
    const base = fakeFetch([blockedResponse()]);
    const t = makeTransport({ base });

    await expect(t("https://airline.example/api", { method: "GET" })).rejects.toThrow(BlockedError);
  });

  it("carries the reason and status, so a task can record `blocked` not `failed`", async () => {
    // Those two call for opposite responses: try the browser vs. fix the parser.
    const t = makeTransport({ base: fakeFetch([blockedResponse()]) });
    const err = await t("https://airline.example/api", { method: "GET" }).catch((e) => e);

    expect(err).toBeInstanceOf(BlockedError);
    expect(err.status).toBe(403);
    expect(err.reason).toContain("403");
    expect(err.url).toBe("https://airline.example/api");
  });

  it("is sticky: once refused, the rest of the fan-out never touches the network", async () => {
    // Hammering a source that has already said no is both pointless and the
    // fastest way to make the refusal permanent.
    const base = fakeFetch([blockedResponse()]);
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
});
