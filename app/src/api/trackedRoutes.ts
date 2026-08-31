import { req } from "./client";
import type {
  RoutesData,
  RouteInput,
  TrackedRoute,
} from "../../../api/src/models/wire/index.js";

/** The Routes page in one request — the tracked routes AND the current finds
 *  under each. `trackedRoutes` below is the route rows alone. */
export const routes = () => req<RoutesData>("/routes");

export const trackedRoutes = () => req<TrackedRoute[]>("/tracked-routes");

export const addTrackedRoute = (body: RouteInput) =>
  req<{ id: number }>("/tracked-routes", { method: "POST", body: JSON.stringify(body) });

/** Edit a stored route. The Worker MERGES this against the stored row — an
 *  absent field is left alone, an empty array clears that filter — so a caller
 *  holding only part of a route can send only that part. Both callers rely on
 *  it: the edit dialog sends the gathering spec, and the header's filter chips
 *  send one field each. */
export const updateTrackedRoute = (id: number, body: Partial<RouteInput>) =>
  req<{ ok: true }>(`/tracked-routes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

/**
 * What hubs the route graph would suggest for this route right now.
 *
 * **Writes nothing** — it fills the edit dialog's Via field and Save is what
 * commits, so asking is free and Cancel still cancels. PATCH will not re-ask for
 * a route that already has hubs (its merge keeps what somebody chose), so this
 * is the only way to re-rank after the graph gains a program.
 */
export const suggestRoutePaths = (id: number) =>
  req<{ via: string[] }>(`/tracked-routes/${id}/paths`);

export const deleteTrackedRoute = (id: number) =>
  req<{ ok: true }>(`/tracked-routes/${id}`, { method: "DELETE" });
