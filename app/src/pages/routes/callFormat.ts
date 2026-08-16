// Formatting for the captured seats.aero calls the search panel can open.
//
// Pure, and a `.ts` file rather than living inside `CallDialog.tsx`, so the two
// size thresholds below are reachable by a test. They are the load-bearing part:
// a full page of trips is close to a megabyte of JSON, and indenting or
// rendering all of it will hang the tab.

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The query string alone. The host and path are the same on every call, so
 *  showing them in the list is noise — the modal has the full URL. */
export function callSummary(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(q + 1);
}

/** Pretty-print JSON when it's small enough to be worth the work and the DOM can
 *  take it. A megabyte of indented text will hang the tab, so past the threshold
 *  the raw body is shown as it arrived. */
export const PRETTY_LIMIT = 512_000;
/** Hard cap on what goes into the DOM. The full body is still one click away on
 *  the copy button — this only bounds what is *rendered*. */
export const RENDER_LIMIT = 400_000;

export function formatBody(body: string): { text: string; pretty: boolean } {
  if (body.length <= PRETTY_LIMIT) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), pretty: true };
    } catch {
      /* not JSON — fall through and show it raw */
    }
  }
  return { text: body, pretty: false };
}
