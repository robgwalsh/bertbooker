import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RouteInput } from "../../../api";

/** The read filters, by the name each one travels under on the wire. */
export type FilterField = "cabins" | "currencies" | "minSeats" | "directOnly" | "pointLimit";

/** What the page watches with `useIsMutating` to know a filter is saving. The
 *  PATCH is most of the wait — the refetch behind it is a warm read — so a
 *  progress bar hung on the query alone starts late and looks like nothing
 *  happened. */
export const ROUTE_FILTER_MUTATION_KEY = ["route-filters"];

/**
 * One read filter, saved the moment it changes.
 *
 * ONE mutation for the whole route rather than one per chip, with the field
 * riding as a mutation VARIABLE — which is what gives each chip its own pending
 * and error state without five hooks. `EditRouteDialog` uses the same trick to
 * decide which of its two buttons says "Saving…".
 *
 * `scope` serialises them. Ticking three cabins in one open popover is three
 * PATCHes, and TanStack runs a scope's mutations one after another, so they
 * cannot land out of order. Each request carries the ABSOLUTE value rather than
 * a delta, so even a lost one leaves the row meaning something somebody chose.
 *
 * No optimistic update — the app has none anywhere and none is needed here. The
 * popover holds its own draft, so its controls answer instantly, and it covers
 * the chip until the refetch lands.
 */
export function useRouteFilterPatch(routeId: number) {
  const qc = useQueryClient();

  const patch = useMutation<unknown, Error, { field: FilterField; body: Partial<RouteInput> }>({
    mutationKey: [...ROUTE_FILTER_MUTATION_KEY, routeId],
    scope: { id: `route-filters-${routeId}` },
    mutationFn: ({ body }) => api.updateTrackedRoute(routeId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["tracked-routes"] });
    },
  });

  return {
    set: (field: FilterField, body: Partial<RouteInput>) => patch.mutate({ field, body }),
    /** The field currently in flight, if any. */
    pending: patch.isPending ? patch.variables.field : undefined,
    /** The field whose last save failed, and why. Cleared by the next attempt. */
    failed: patch.isError ? patch.variables?.field : undefined,
    error: patch.error,
  };
}
