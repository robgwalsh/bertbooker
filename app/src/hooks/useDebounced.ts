import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value (a search box) to limit backend calls.
 *
 * One copy. This was defined identically, character for character, in both
 * `AirportAutocomplete.tsx` and the Airports pane — the two surfaces that type
 * into `/api/airports`. Neither copy was wrong, which is exactly why the
 * duplication survived: nothing would ever have gone red.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
