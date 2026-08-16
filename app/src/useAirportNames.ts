import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AirportName } from "./api";

/**
 * Resolve IATA codes to airport rows — one round trip for every code on screen.
 *
 * Extracted because three surfaces want the same answer for the same codes: the
 * Routes page names the pills in a route's header, and both trip lists plot the
 * airports on a `RouteMap`. Calling it per row would be one request per find; a
 * caller therefore passes the UNION of the codes it will draw, and hands the map
 * down to its rows.
 *
 * Reference data that cannot change within a session, hence `staleTime:
 * Infinity`. The query key is the sorted, deduplicated code list, so two callers
 * asking for the same set share one cache entry and a set that grows refetches
 * while a set that shrinks does not.
 */
export function useAirportNames(codes: string[]): Map<string, AirportName> {
  // Sorted and deduplicated inside the hook, not by each caller: the key IS the
  // list, so "SEA,LAX" and "LAX,SEA" would otherwise be two fetches for one
  // answer. Memoized so a new array identity per render can't retrigger the
  // query.
  const key = useMemo(() => [...new Set(codes)].sort(), [codes.join(",")]);

  const { data } = useQuery({
    queryKey: ["airport-names", key],
    queryFn: () => api.airportNames(key),
    enabled: key.length > 0,
    staleTime: Infinity,
  });

  return useMemo(() => {
    const byCode = new Map<string, AirportName>();
    // The endpoint ranks its rows, so the FIRST hit for a code is the best one —
    // an IATA code can be shared with a heliport or a closed field.
    for (const a of data ?? []) if (!byCode.has(a.iata)) byCode.set(a.iata, a);
    return byCode;
  }, [data]);
}
