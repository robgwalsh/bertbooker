import { notifyLocked } from "../lib/auth";
import { readNdjson, req, searchErrorMessage, SEARCH_TIMEOUT_MS } from "./client";
import type {
  ApiErrorBody,
  EnrichEvent,
  EnrichOutcome,
} from "../../../api/src/models/wire/index.js";

/**
 * Buy the real itinerary behind one summary find — one seats.aero call.
 *
 * No cabin: one availability id covers all four, so the call the user is
 * paying for expands every sibling row too and the response reports them all.
 */
export const enrichFind = (body: {
  origin: string;
  destination: string;
  flightDate: string;
  program: string;
}) => req<EnrichOutcome>("/finds/enrich", { method: "POST", body: JSON.stringify(body) });

/**
 * Enrich every summary find under one tracked route, yielding each frame.
 *
 * Same shape and same rules as `searchRoute`: fallible checks land as status
 * codes before the first byte, and a stream that ends without a terminal frame
 * is a failure — never "nothing needed enriching".
 */
export async function* enrichRoute(
  id: number,
  signal?: AbortSignal,
): AsyncGenerator<EnrichEvent> {
  const path = `/tracked-routes/${id}/enrich`;
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (res.status === 401 && detail?.error === "locked") notifyLocked();
    throw new Error(searchErrorMessage(detail?.error) ?? `POST ${path} -> ${res.status}`);
  }
  yield* readNdjson<EnrichEvent>(res);
}
