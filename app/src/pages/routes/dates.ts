// Date helpers for the route form and its header.
//
// Both go through UTC deliberately: a route's window is a pair of bare
// `YYYY-MM-DD` strings with no timezone, and handing one to a local-time
// `Date` shifts it by the viewer's offset — which lands the window a day out
// west of Greenwich. Same trap `dayLabel` guards against in `lib/format.ts`.

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Format an ISO date (YYYY-MM-DD) as American M/D/YYYY. Parsed from the parts
// directly so the calendar day is never shifted by the local timezone.
export function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(m)}/${Number(d)}/${y}`;
}
