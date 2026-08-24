// The transport every gated call shares: one fetch wrapper, one error type, one
// NDJSON reader, and the map that turns the Worker's refusal codes into
// sentences.
//
// Every path here is relative and that is deliberate: in prod the same worker
// serves this bundle and answers /api/*, so there is no base URL to configure;
// in dev vite.config.ts proxies /api to :8787.

import { notifyLocked } from "../lib/auth";
import type { ApiErrorBody, ApiErrorCode } from "../../../shared/src/wire/index.js";

/** A failed API response, carrying the two things a caller might branch on. The
 *  message keeps the old `GET /path -> 401` shape, because that is what any
 *  existing error UI is already rendering. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The Worker's machine-readable `{"error":...}` code, when it sent one. */
    readonly code: string | null,
    message: string,
    /** The Worker's human-readable `{"message":...}`, when it sent one.
     *
     *  Separate from `message`, which keeps its `POST /path -> 400 code` shape
     *  because existing error UI already renders that. Where the Worker wrote a
     *  sentence for a person — the settings writes do — this is it, and it beats
     *  anything the SPA could reconstruct from the code alone. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Every gated call goes through here.
 *
 * The session is an HttpOnly cookie, so there is nothing to attach — the browser
 * does it, and `credentials` is stated rather than left to the default so the
 * reason is visible at the call site. What this adds is the lockout hand-off: a
 * 401 whose body says `locked` is reported to `auth.ts`, which turns "this one
 * query failed" into "show the password dialog" instead of every panel on the
 * page failing separately with a generic error.
 */
export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as ApiErrorBody | null;
    const code = detail?.error ?? null;
    if (res.status === 401 && code === "locked") notifyLocked();
    throw new ApiError(
      res.status,
      code,
      `${init?.method ?? "GET"} ${path} -> ${res.status}${code ? ` ${code}` : ""}`,
      detail?.message,
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Yield newline-delimited JSON frames from a streaming response.
 *
 * Shared by the two streams in this app — the Worker's route search and its
 * enrich-all — because the buffering rule is the easy thing to get subtly wrong:
 * a chunk boundary can land mid-frame, so anything after the last newline stays
 * buffered until more arrives.
 *
 * Says nothing about terminal frames; that contract belongs to each stream and is
 * enforced by its caller. Both hold the same rule: a stream that ends without a
 * `run_done` or `error` frame died mid-flight and must be read as a failure,
 * never as an empty result.
 */
export async function* readNdjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) throw new Error("stream returned no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as T;
}

/** How long the UI waits on a whole route search. Five 90-day chunks at a couple
 *  of seconds each is the normal case; this is only here so a wedged connection
 *  eventually gives up instead of spinning until the tab closes. */
export const SEARCH_TIMEOUT_MS = 5 * 60_000;

/**
 * The Worker's pre-stream refusals, in words a person can act on. Shared by
 * `searchRoute` and `enrichRoute` — the two overlap on every code but their own,
 * and duplicating the map would let them drift.
 *
 * Keyed by `ApiErrorCode`, which is the Worker's own vocabulary. That is the
 * whole reason the code union exists: explaining a code the Worker never sends,
 * or missing a rename on one side, is now a compile error rather than a sentence
 * nobody ever reads. `Partial` because most codes have no user-actionable
 * wording and fall through to the raw message.
 */
export const SEARCH_ERRORS: Partial<Record<ApiErrorCode, string>> = {
  no_seats_aero_key:
    "seats.aero API key not configured — set SEATS_AERO_API_KEY (api/.dev.vars locally, or a Worker secret).",
  window_outside_horizon:
    "This route's date window is entirely in the past or beyond seats.aero's ~1 year horizon.",
  not_found: "That route no longer exists.",
  nothing_to_enrich:
    "Every seats.aero find on this route already has its itinerary — nothing left to fetch.",
  locked: "Your session expired. Enter the password again and re-run the search.",
  no_app_password:
    "The API has no APP_PASSWORD configured — set it with `wrangler secret put APP_PASSWORD`.",
  no_session_secret:
    "The API has no SESSION_SECRET configured — set it with `wrangler secret put SESSION_SECRET`.",
};

/** Look up a refusal code's sentence. Narrowing happens here rather than at the
 *  two call sites, which hold an arbitrary string off the wire. */
export function searchErrorMessage(code: string | null | undefined): string | undefined {
  return SEARCH_ERRORS[(code ?? "") as ApiErrorCode];
}
