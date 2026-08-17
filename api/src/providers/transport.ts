// HTTP transport for fetch-based sources: issue the request, classify the
// response, and refuse to hand a challenge page to a parser.
//
// The valuable part is telling "the source said no" apart from "the source
// said there is no award space" (docs/HARVEST-POSTMORTEM.md) — which are the
// same empty result set and opposite facts.
//
// `detectBlock` is pure and is the single most important thing to keep tested:
// a false negative means we parse a challenge page as award data, and a false
// positive means a working source reports itself broken.

// Type-only, so this stays a leaf module at runtime and there is no cycle with
// ingest/types.ts.
import type { SourceTaskStatus } from "../ingest/types.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
}

/** Thrown by `makeTransport` when a response classifies as an anti-bot block.
 *  Distinct from a plain HTTP error so a task can record `blocked`
 *  rather than `failed` — the two call for completely different responses (try
 *  the browser vs. fix the parser). */
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
 * means try a browser or back off, `failed` means the parser or the plan is
 * wrong. Collapsing them into one bucket is how the pre-pivot design managed to
 * record "United is unusable" when it was actually being challenged.
 *
 * Lives here, in shared, because three callers need it and must agree: the
 * search endpoint, enrich, and the alert sweep. Whatever this returns decides
 * whether the task claims coverage, and therefore whether it may prune.
 *
 * `blocked` and `challenged` are effectively unreachable now — they were the
 * vocabulary of the carrier scrapers, and seats.aero returns HTTP errors rather
 * than challenge pages. They stay because the distinction they encode is the
 * point of the function, and because `detectBlock` below is what stops a
 * challenge page ever reaching a parser as data.
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

/** Substrings that appear in anti-bot challenge/denial bodies. Lowercase; the
 *  body is lowercased before matching. Extend from a real captured denial body
 *  — do not guess. */
const BLOCK_MARKERS = [
  "access denied",
  "request unsuccessful. incapsula",
  "_incapsula_",
  "px-captcha",
  "/_px/",
  "pardon our interruption",
  "akamai reference number",
  "reference #18.",
  "cf-chl",
  "distil",
  "captcha",
  "are you a human",
  "bot detection",
];

/** How much of the body to inspect. Challenge pages announce themselves early,
 *  and a real award response can be megabytes. */
const PEEK_BYTES = 2048;

/**
 * Classify a response as an anti-bot block. Pure.
 *
 * `403`/`429`/`451`/`503` are the usual denial codes. `428 Precondition
 * Required` is Akamai's "we want a JS challenge solved" — United returns it.
 * `444` is Akamai's edge deny (Delta returns it on every shopping endpoint);
 * checking the status code directly, rather than only the "access denied"
 * body marker, is what keeps a carrier that denies with an empty body from
 * reading as a bad recipe.
 * A 200 carrying HTML where the caller expects JSON means we were served a
 * challenge or interstitial rather than the API.
 */
export function detectBlock(
  status: number,
  contentType: string | null,
  bodyPeek: string,
): BlockSignal {
  if (status === 403 || status === 401) return { blocked: true, reason: `http ${status}` };
  if (status === 429) return { blocked: true, reason: "rate limited" };
  if (status === 428) return { blocked: true, reason: "http 428 (js challenge)" };
  if (status === 444) return { blocked: true, reason: "http 444 (edge deny)" };
  if (status === 451 || status === 503) return { blocked: true, reason: `http ${status}` };

  const ct = (contentType ?? "").toLowerCase();
  if (status === 200 && ct.includes("text/html")) {
    return { blocked: true, reason: "html where json expected" };
  }

  const peek = (bodyPeek ?? "").slice(0, PEEK_BYTES).toLowerCase();
  for (const marker of BLOCK_MARKERS) {
    if (peek.includes(marker)) return { blocked: true, reason: `marker: ${marker}` };
  }
  return { blocked: false };
}

export interface TransportOptions {
  /** Underlying fetch. The test/DI seam; defaults to global fetch. */
  base?: FetchLike;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Treat an HTML 200 as a block. Off for a source whose real payload IS HTML,
   *  i.e. one that server-renders its results into the page. */
  expectJson?: boolean;
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
 * A FetchLike that throws {@link BlockedError} instead of returning a challenge
 * page.
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
  const expectJson = opts.expectJson ?? true;
  let blockedBy: BlockSignal | undefined;

  return async (url: string, init: RequestInit): Promise<Response> => {
    if (blockedBy) throw new BlockedError(url, 0, `${blockedBy.reason} (sticky)`);

    const res = await base(url, init);
    const text = await res.text();
    const block = detectBlock(res.status, expectJson ? res.headers.get("content-type") : null, text);
    if (block.blocked) {
      blockedBy = block;
      log(`blocked (${block.reason})`, { url, status: res.status, reason: block.reason });
      throw new BlockedError(url, res.status, block.reason ?? "unknown");
    }
    return rebuild(res.status, res.headers, text);
  };
}
