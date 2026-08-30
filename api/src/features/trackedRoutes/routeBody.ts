import { ALL_ALERT_TYPES } from "../alerts/select.js";
import { isRecipientAllowed } from "../alerts/recipients.js";
import { MAX_VIA } from "../../domain/routing.js";
import { CABIN_ORDER } from "../../domain/types.js";
import { CURRENCIES } from "../../domain/programs.js";
import type { Env } from "../../bindings.js";
import type { RouteInput } from "../../../../shared/src/wire/index.js";

/**
 * What the Worker ACCEPTS for a route, and everything that turns it into what
 * will be stored: the validators, the clamps and the column shapes.
 *
 * Split from the handlers because it is the half with no HTTP in it. Nothing
 * here reads a `Context`, and the two handlers are then short enough to read as
 * what they are — a merge and a write.
 */

/**
 * What a route is, on the wire. `POST` requires the window; `PATCH` treats every
 * field as optional and merges against the stored row.
 *
 * **Deliberately NOT the same type as `RouteInput`** in
 * `shared/src/wire/rows.ts`, which is what the SPA's form sends. This is what
 * the Worker ACCEPTS, and it is a wider, older shape in three ways that all
 * still matter: the pre-sets scalar `origin`/`destination`; `programs` and
 * `kind`, which no current client sends; and `null` as an explicit "clear this
 * filter", which is a distinct instruction from an absent field's "leave it
 * alone". Collapsing the two would have to give one of those up.
 *
 * `alertOn` is `string[]` and not `AlertType[]` for the same reason: this
 * describes what ARRIVED, not what is legal. `validateAlerts` below is what
 * turns one into the other.
 *
 * The assertion under the interface is what keeps them in step.
 */
export interface RouteBody {
  origin?: string;
  destination?: string;
  /** The authoritative airport sets. `origin`/`destination` remain accepted so
   *  an older client still works, and are the fallback when these are absent. */
  origins?: string[] | null;
  destinations?: string[] | null;
  /**
   * Hubs to route through, at most `MAX_VIA`.
   *
   * Three-valued, and all three mean different things. **Absent** = "work it
   * out": the Worker asks the route graph and fills in the best hubs, which is
   * the whole point — a route on a pair nobody monitors should not need the user
   * to know that, or to know which hubs. **An empty array** = "no hubs, I mean
   * it", and is never auto-filled over. **A list** is taken as given.
   */
  via?: string[] | null;
  dateStart?: string;
  dateEnd?: string;
  cabins?: string[] | null;
  minSeats?: number;
  programs?: string[] | null;
  currencies?: string[] | null;
  kind?: string;
  /** Show only nonstop finds under this route. A read filter; see the migration. */
  directOnly?: boolean;
  /** The most miles an award may cost to be shown. A read filter; see
   *  Three-valued like the list filters above: absent keeps
   *  what is stored, `null` clears the limit, a number sets it. */
  pointLimit?: number | null;
  /** Search BOTH directions. A gathering setting, not a read filter — turning
   *  it on needs a re-search before the return legs exist. */
  roundTrip?: boolean;
  /** Email me when this route changes. The second setting that changes what is
   *  GATHERED rather than what is shown: it enrolls the route in the cron sweep.
   *  See docs/ALERTS.md. */
  alertsEnabled?: boolean;
  /** Where the digest goes. Empty/null = the account's own address. Checked
   *  against the `alert_recipients` allowlist. */
  alertEmail?: string | null;
  /** Which transitions fire. `undefined` keeps what is stored; `null` resets to
   *  the default set. An EMPTY ARRAY is refused — see below. */
  alertOn?: string[] | null;
  alertMinDropPct?: number;
}

/**
 * Everything the SPA can send, this handler must accept.
 *
 * A compile-time assertion and nothing else — it emits no code. `RouteInput`
 * (the SPA's form contract) and `RouteBody` (what this route parses) are allowed
 * to differ, but only in the direction of this being wider. Add a field to
 * `RouteInput`, or change one's type, and this line fails rather than the
 * mismatch reaching a handler that silently ignores it. That is the check the
 * hand-mirrored pair never had.
 */
type Assert<T extends true> = T;
type _RouteInputIsAcceptable = Assert<RouteInput extends RouteBody ? true : false>;

/** `via` as it should be STORED: null for none, JSON otherwise. Null rather than
 *  `"[]"` so the column reads the way `cabins` and `currencies` do, and so
 *  `parseCodeList` needs no special case. */
export const viaColumn = (hubs: string[]): string | null =>
  hubs.length ? JSON.stringify(hubs.slice(0, MAX_VIA)) : null;

/**
 * Validate the alert settings shared by POST and PATCH.
 *
 * The empty-array rule is the one worth stating. Every other list column here
 * (`cabins`, `currencies`) treats `[]` as "no filter, everything matches", and
 * copying that convention would make `alert_on: []` mean *nothing ever fires* —
 * a route that looks armed and is silent forever, which is the single most
 * plausible way for this feature to appear broken while behaving exactly as
 * configured. So it is a 400 rather than a stored value, and `null` is the only
 * way to ask for the default set.
 */
export async function validateAlerts(
  b: RouteBody,
  env: Env,
): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  if (b.alertOn !== undefined && b.alertOn !== null) {
    // Bounded as well as checked. The membership test below rejects unknown
    // VALUES but said nothing about how many, so `["new"]` repeated a hundred
    // thousand times passed and was stringified into the column — and
    // `alert_on` is re-parsed by every sweep. There are only so many distinct
    // kinds of change, so the list of them is its own cap.
    if (Array.isArray(b.alertOn) && b.alertOn.length > ALL_ALERT_TYPES.length) {
      return {
        ok: false,
        error: "bad_alert_types",
        message: "Too many alert kinds.",
      };
    }
    if (!Array.isArray(b.alertOn) || b.alertOn.length === 0) {
      return {
        ok: false,
        error: "bad_alert_types",
        message: "Choose at least one kind of change to be told about.",
      };
    }
    const unknown = b.alertOn.filter((t) => !(ALL_ALERT_TYPES as string[]).includes(t));
    if (unknown.length) {
      return { ok: false, error: "bad_alert_types", message: `Unknown: ${unknown.join(", ")}` };
    }
  }
  if (b.alertEmail) {
    if (!(await isRecipientAllowed(env, b.alertEmail))) {
      return {
        ok: false,
        error: "recipient_not_allowed",
        message: `${b.alertEmail} is not an allowed recipient. Add it under Settings → System.`,
      };
    }
  }
  return { ok: true };
}

/**
 * The JSON list columns, bounded and — where the vocabulary is closed — checked
 * against it.
 *
 * `cabins`, `currencies` and `programs` were stringified straight out of the
 * request body with no cap on length and no check on content at all. They are
 * re-parsed by `json_each` in every scan and by every
 * sweep, so a multi-megabyte array is not merely an odd-looking row: it is a
 * cost paid on every read of the Routes page, for as long as the route exists,
 * by a route that looks entirely normal in the UI.
 *
 * VALIDATION ONLY — nothing is normalised or rewritten here, so PATCH's
 * three-valued merge downstream (`undefined` keeps what is stored, `[]` clears
 * the filter to "any") is untouched.
 *
 * `programs` is bounded but deliberately NOT allowlisted: the `programs` table
 * is editable reference data, so a fixed list here would fight it, and an
 * unknown code only ever narrows a filter to nothing.
 */
export function validateLists(b: RouteBody): { ok: true } | { ok: false; message: string } {
  const checks: [string, unknown, readonly string[] | null, number][] = [
    ["cabins", b.cabins, CABIN_ORDER, CABIN_ORDER.length],
    ["currencies", b.currencies, CURRENCY_CODES, CURRENCY_CODES.length],
    ["programs", b.programs, null, 64],
  ];
  for (const [label, value, allowed, cap] of checks) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return { ok: false, message: `${label} must be a list.` };
    if (value.length > cap) {
      return { ok: false, message: `Too many ${label} (at most ${cap}).` };
    }
    if (allowed) {
      const unknown = [...new Set(value.map(String))].filter((v) => !allowed.includes(v));
      if (unknown.length) {
        return { ok: false, message: `Unknown ${label}: ${unknown.join(", ")}` };
      }
    }
  }
  return { ok: true };
}

/** The currency codes a route may filter on — derived from the one catalogue in
 *  `domain/programs.ts` rather than restated, so adding a currency there is the
 *  whole of adding it. */
const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code);

/** 0–100, and a whole number: a fractional percentage threshold is a decision
 *  nobody makes and a column nobody can read back.
 *
 *  `Number.isFinite` first, for the reason `clampPointLimit` below spells out:
 *  `Math.round(NaN)` is `NaN`, and `NaN` passes straight through `Math.min` and
 *  `Math.max` untouched. Written as a bare clamp chain over an untrusted body
 *  field — which is how this was written — a non-numeric value reached a NOT
 *  NULL INTEGER column. */
export const clampDropPct = (v: unknown, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(Math.round(v as number), 0), 100) : fallback;

/** Seats per booking as it will be stored: a whole number, 1–9. Same
 *  `Number.isFinite` guard and the same reason as `clampDropPct` above — this
 *  was the second bare clamp chain, written out twice (POST and PATCH). */
export const clampMinSeats = (v: unknown, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(Math.round(v as number), 1), 9) : fallback;

/**
 * A points ceiling as it will be stored: a positive whole number, or NULL for
 * no limit.
 *
 * Three-valued in, two-valued out. `undefined` means "leave it alone" and never
 * reaches here; `null` clears it. **Zero and anything negative clear it too**,
 * rather than being stored — a route that hides every find it has looks exactly
 * like a broken one, which is the same reasoning that refuses an empty
 * `alert_on`. The upper bound is generous on purpose: it exists to keep a typo
 * out of an INTEGER column, not to have an opinion about award charts.
 */
export const clampPointLimit = (v: number | null | undefined, fallback: number | null): number | null => {
  if (v === undefined) return fallback;
  if (v === null || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n > 0 ? Math.min(n, 100_000_000) : null;
};

/** A stored JSON array column back into a code list. Never throws: a route whose
 *  `origins` somehow isn't JSON should edit as unset, not 500. */
export function storedList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}
