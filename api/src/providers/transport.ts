// HTTP transport for the seats.aero calls: issue the request, classify the
// response, and refuse to hand a refusal to a parser as if it were data.
//
// The valuable part is telling "the source said no" apart from "the source
// said there is no award space" (docs/SEATS-AERO.md §9) — which are the same
// empty result set and opposite facts.
//
// `detectBlock` is pure and is the single most important thing to keep tested:
// a false negative means we parse a denial page as award data, and a false
// positive means a working call reports itself broken.

// Type-only, so this stays a leaf module at runtime and there is no cycle with
// ingest/types.ts.
import type { SourceTaskStatus } from "../ingest/types.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
}

/** Thrown by `makeTransport` when a response classifies as a refusal (bad key,
 *  quota exhausted, outage). Distinct from a plain HTTP error so a task can
 *  record `blocked` rather than `failed` — the two call for completely
 *  different responses (back off and retry later vs. fix the parser). */
export class BlockedError extends Error {
  readonly reason: string;
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number, reason: string) {
    super(`blocked: ${reason} (${status}) ${url}`);
    this.name = "BlockedError";
    this.reason = reason;
    this.status = status;
    this.url = url;
  }
}

/**
 * Classify a thrown error into a task status.
 *
 * The distinction earns its keep because the remedies are opposite: `blocked`
 * means back off (bad key, quota gone, outage), `failed` means the parser or
 * the plan is wrong.
 *
 * Lives here, in shared, because three callers need it and must agree: the
 * search endpoint, enrich, and the alert sweep. Whatever this returns decides
 * whether the task claims coverage, and therefore whether it may prune.
 *
 * `blocked` is very much reachable — it's how a wrong `SEATS_AERO_API_KEY`
 * (401) or an exhausted daily allowance (429) get classified; see
 * docs/SEATS-AERO.md §9. `challenged` is the one that's vestigial: it was the
 * vocabulary of the carrier scrapers this app no longer runs, and nothing
 * `detectBlock` produces below can trigger it anymore. It stays as a status
 * only because `SourceTaskStatus` still declares it
 * value.
 */
export function classifyError(err: unknown): { status: SourceTaskStatus; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BlockedError) return { status: "blocked", message };
  if (/\bchallenge\b|captcha/i.test(message)) return { status: "challenged", message };
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { status: "timeout", message };
  }
  if (/timed? ?out|etimedout/i.test(message)) return { status: "timeout", message };
  return { status: "failed", message };
}

/**
 * The version of an error a BROWSER may be shown.
 *
 * Error text here comes from two places that deserve opposite treatment.
 *
 * A `BlockedError` is this app's OWN sentence about a vendor refusal — "blocked:
 * rate limited (429)" — which is safe, and is genuinely the most useful thing
 * the UI can say. It is kept, minus the URL it embeds: that URL is the full
 * seats.aero request including its query string, which is nobody's business on
 * the wire and is exactly the sort of thing that ends up in a screenshot.
 *
 * Everything else is unbounded. A D1 failure arrives as `D1_ERROR: NOT NULL
 * constraint failed: finds.<column>`, a bind overflow as "too
 * many SQL variables", a parser bug as whatever the runtime said. That is
 * internal schema and internal structure, and it was being streamed to the
 * client AND persisted into `runs.error`, which the Alerts tab renders
 * straight back. Those become one fixed sentence.
 *
 * Nothing is lost for debugging: callers still record `classifyError`'s raw
 * message on the run, and Workers Logs still has the throw. This decides only
 * what crosses the wire.
 */
export function clientMessage(err: unknown): string {
  if (err instanceof BlockedError) return `blocked: ${err.reason} (${err.status})`;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return "the source timed out";
  }
  return "unexpected error — the cause is recorded on the run";
}

/**
 * Classify a response status as a refusal from the keyed API. Pure.
 *
 * `401`/`403` mean the key is wrong or revoked, `429` means the day's
 * allowance is gone, `451`/`503` mean the API is unavailable. All five are
 * "the source said no", not "the source said there is no award space", and
 * must never be handed to a parser as an empty result — see docs/SEATS-AERO.md
 * §9.
 */
export function detectBlock(status: number): BlockSignal {
  if (status === 401 || status === 403) return { blocked: true, reason: `http ${status}` };
  if (status === 429) return { blocked: true, reason: "rate limited" };
  if (status === 451 || status === 503) return { blocked: true, reason: `http ${status}` };
  return { blocked: false };
}

export interface TransportOptions {
  /** Underlying fetch. The test/DI seam; defaults to global fetch. */
  base?: FetchLike;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Rebuild a Response after its body has been read for classification.
 *  `content-encoding`/`content-length` describe the ORIGINAL compressed bytes;
 *  carrying them onto an already-decoded string body corrupts it downstream. */
function rebuild(status: number, headers: Headers, body: string): Response {
  const out = new Headers();
  headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding")
      return;
    if (lower === "set-cookie") return;
    out.set(k, v);
  });
  return new Response(body, { status, headers: out });
}

/**
 * A FetchLike that throws {@link BlockedError} instead of returning a refusal
 * response.
 *
 * STICKY: once anything has been blocked, subsequent requests fail immediately
 * without touching the network. A fan-out covers a dozen date windows; hammering
 * a source that has already refused us is both pointless and the fastest way to
 * make the refusal permanent. Create one transport per task group so the
 * stickiness has the right lifetime.
 */
export function makeTransport(opts: TransportOptions = {}): FetchLike {
  const base: FetchLike = opts.base ?? ((u, i) => fetch(u, i));
  const log = opts.log ?? (() => {});
  let blockedBy: BlockSignal | undefined;

  return async (url: string, init: RequestInit): Promise<Response> => {
    if (blockedBy) throw new BlockedError(url, 0, `${blockedBy.reason} (sticky)`);

    const res = await base(url, init);
    const text = await res.text();
    const block = detectBlock(res.status);
    if (block.blocked) {
      blockedBy = block;
      log(`blocked (${block.reason})`, { url, status: res.status, reason: block.reason });
      throw new BlockedError(url, res.status, block.reason ?? "unknown");
    }
    return rebuild(res.status, res.headers, text);
  };
}
