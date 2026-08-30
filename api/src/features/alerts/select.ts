import type { ChangeSummary, ChangeType } from "../../models/change.js";

/**
 * Which of a sweep's changes are worth an email.
 *
 * Pure, and deliberately does NOT re-implement the route's read filters. That
 * question — *would this route's own pane show this find?* — is answered by
 * `routeMatcher` (`shared/src/match/routeMatch.ts`), the same predicate the
 * Routes page runs, and the caller hands the answer in as `findKeys`.
 *
 * The reason is worth stating, because writing the filter here would have been
 * the obvious thing to do: a second copy of "can the couple book this?" would
 * drift from the one the page uses, and an alert that fires on a find the
 * route's own pane hides is indistinguishable from a bug in either half.
 */

/** The four transitions `diffAvailability` classifies. */
export const ALL_ALERT_TYPES: ChangeType[] = ["new", "more_seats", "price_drop", "gone"];

/**
 * What a route alerts on when it has not said.
 *
 * `gone` is out: most disappearances are cache churn or dates ageing off the
 * front of the window, and it is the one type that cannot be intersected with
 * the finds query — there is no current row left to match — so it honours fewer
 * of the route's filters than the others. `more_seats` is out because a seat
 * count rising on space you already knew about is rarely why you are watching.
 */
export const DEFAULT_ALERT_TYPES: ChangeType[] = ["new", "price_drop"];

export interface AlertRule {
  /** NULL/undefined in the column means the default set. An EMPTY array is
   *  rejected at the API rather than stored — see the migration; it would mean
   *  "alerts on, nothing fires", which is indistinguishable from broken. */
  types: ChangeType[];
  /** Minimum drop, in percent, for `price_drop` to qualify. */
  minDropPct: number;
}

export function parseAlertTypes(json: string | null | undefined): ChangeType[] {
  if (!json) return DEFAULT_ALERT_TYPES;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return DEFAULT_ALERT_TYPES;
    const kept = parsed.filter((t): t is ChangeType =>
      (ALL_ALERT_TYPES as string[]).includes(String(t)),
    );
    // A stored array that survives parsing but holds nothing we recognise is a
    // corrupted value, not a request for silence. The API refuses to write an
    // empty set precisely so that reading one back means something went wrong.
    return kept.length ? kept : DEFAULT_ALERT_TYPES;
  } catch {
    return DEFAULT_ALERT_TYPES;
  }
}

/** How far a price fell, as a percentage of what it was. 0 when there is no
 *  prior price to compare against, or the prior price was zero. */
export function dropPercent(c: ChangeSummary): number {
  if (c.previousMilesCost == null || c.milesCost == null) return 0;
  if (c.previousMilesCost <= 0) return 0;
  const delta = c.previousMilesCost - c.milesCost;
  if (delta <= 0) return 0;
  return (delta / c.previousMilesCost) * 100;
}

/**
 * The changes this route should email about.
 *
 * `findKeys` is the set of `changeKey`s that survive the route's own filters,
 * read out of the finds query after the sweep. A change whose key is absent
 * describes a seat the route's pane would not show, so it is not this route's
 * business however real it is.
 *
 * **`gone` bypasses the intersection, and must.** The whole point of `gone` is
 * that the row is no longer there, so it can never appear in a query of current
 * finds; intersecting it would silently drop every disappearance. It is filtered
 * on what the summary itself carries instead — cabin, seats and the points
 * ceiling — which means a route's currency and nonstop filters do not apply to
 * it — one more reason it is opt-in.
 */
export function selectAlertable(
  changes: ChangeSummary[],
  findKeys: ReadonlySet<string>,
  rule: AlertRule,
  routeFilters: { cabins?: string[] | null; minSeats: number; pointLimit?: number | null },
): ChangeSummary[] {
  const wanted = new Set(rule.types);
  const out: ChangeSummary[] = [];
  const seen = new Set<string>();

  for (const c of changes) {
    if (!wanted.has(c.type)) continue;
    if (c.type === "price_drop" && dropPercent(c) < rule.minDropPct) continue;

    if (c.type === "gone") {
      // Filtered on the summary, because there is nothing left to join to.
      if (routeFilters.cabins?.length && !routeFilters.cabins.includes(c.cabin)) continue;
      if ((c.previousSeats ?? 0) < routeFilters.minSeats) continue;
      // What it cost while it existed, against the route's ceiling. A seat the
      // pane never showed because it was too dear should not announce itself on
      // the way out. Unknown price passes: `gone` is the one type filtered on the
      // summary alone, and refusing what we cannot price would silently drop
      // real disappearances.
      if (
        routeFilters.pointLimit != null &&
        c.previousMilesCost != null &&
        c.previousMilesCost > routeFilters.pointLimit
      )
        continue;
    } else if (!findKeys.has(c.key)) {
      continue;
    }

    // One sweep can apply several chunks and a resumed sweep several passes, so
    // the same key can legitimately arrive twice. The outbox is unique on it
    // anyway; de-duplicating here keeps the digest's own counts honest.
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }

  return out;
}
