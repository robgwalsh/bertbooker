import { req } from "./client";
import type {
  DashboardData,
  RouteInput,
  TrackedRoute,
} from "../../../shared/src/wire/index.js";

export const dashboard = () => req<DashboardData>("/dashboard");

export const trackedRoutes = () => req<TrackedRoute[]>("/tracked-routes");

export const addTrackedRoute = (body: RouteInput) =>
  req<{ id: number }>("/tracked-routes", { method: "POST", body: JSON.stringify(body) });

/** Edit a stored route. The Worker MERGES this against the stored row — an
 *  absent field is left alone, an empty array clears that filter — so a caller
 *  holding only part of a route can send only that part. The header's edit
 *  mode sends the whole thing. */
export const updateTrackedRoute = (id: number, body: Partial<RouteInput>) =>
  req<{ ok: true }>(`/tracked-routes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteTrackedRoute = (id: number) =>
  req<{ ok: true }>(`/tracked-routes/${id}`, { method: "DELETE" });
