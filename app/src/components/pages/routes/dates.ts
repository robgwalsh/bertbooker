// Date formatting for the route header and the form's read-only labels.
//
// `isoDate` used to live here and now lives in `lib/routeWindow.ts`: the Tools
// page's "Track these legs" button creates routes too, and the default window
// has to be one definition rather than two. What is left is page-private, and
// goes through the date's own parts deliberately — a route's window is a pair of
// bare `YYYY-MM-DD` strings with no timezone, and handing one to a local-time
// `Date` shifts it by the viewer's offset, which lands the window a day out west
// of Greenwich. Same trap `dayLabel` guards against in `lib/format.ts`.

// Format an ISO date (YYYY-MM-DD) as American M/D/YYYY. Parsed from the parts
// directly so the calendar day is never shifted by the local timezone.
export function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(m)}/${Number(d)}/${y}`;
}
