import { useSyncExternalStore } from "react";
import { DEFAULT_THEME_ID, isThemeId } from "./themes";

/**
 * User preferences — how *this browser* likes to read the app.
 *
 * **Deliberately client-only, and deliberately not a D1 table.** Everything the
 * Worker stores is a fact about the data: a route's cabins, its cards, whether
 * it pairs round trips. A preference is not that. It is also not shareable here
 * even if we wanted it to be — the app has ONE shared identity behind the
 * password gate (`APP_USER_EMAIL`), so a server-side preference would be one
 * setting for both users, and the first time they disagreed it would be a bug
 * with no fix. `localStorage` gives each browser its own answer for free.
 *
 * The other candidate was the URL, which is where the Routes page already keeps
 * its *reading* state (`route`, `minNights`/`maxNights` — see
 * `RoutesSearchParams`). That is the right home for a choice you want to
 * bookmark, link, or walk back with the back button. A preference is the
 * opposite: it should survive every navigation and appear in no link.
 *
 * Shape follows `web/src/auth.ts` — a module-level store with a listener set,
 * every storage access wrapped, and no crash on the way to drawing the app.
 */

/**
 * One JSON blob, not a key per preference: one read at startup, one write per
 * change, and adding a preference later adds no key and no migration.
 *
 * Follows the `bertbooker.<area>.<thing>` convention (`auth.ts`). The `.v1` is what
 * lets a future incompatible shape be IGNORED rather than half-parsed — bump it
 * and every old blob becomes "no preferences stored", which is a defined state.
 */
const STORAGE_KEY = "bertbooker.prefs.v1";

export interface Preferences {
  /**
   * Draw the Map column in the Routes page's trip tables.
   *
   * That page is now the only one that draws finds — a general database
   * browser, which kept its map unconditionally, is gone. The preference stays a
   * PROP on the table rather than a read inside it, because that separation is
   * what let the two callers differ and is what a second caller would need
   * again. See `FindsTableOptions.showMap`.
   */
  showMapColumn: boolean;
  /**
   * Which palette from `themes.ts` the app wears.
   *
   * The id, not the palette: storing the colours would freeze a browser on
   * whatever a theme looked like the day it was picked, and every later fix to
   * that theme would reach nobody. It is also why theme ids are permanent —
   * renaming one silently resets everyone who chose it (see `ThemeSpec.id`).
   */
  themeId: string;
}

/** What an unconfigured browser gets. Every field must have one: `parsePreferences`
 *  falls back per FIELD, so a blob missing a key is not a blob that fails. */
export const DEFAULT_PREFERENCES: Preferences = {
  showMapColumn: true,
  themeId: DEFAULT_THEME_ID,
};

/**
 * Read a stored blob into a `Preferences`.
 *
 * **Pure, and takes the raw string rather than reading storage** — which is the
 * only reason it is testable: the web workspace runs vitest in a Node
 * environment with no DOM and no `localStorage` (see `preferences.test.ts`).
 *
 * Every field falls back independently, and anything unparseable yields the
 * defaults whole. Hand-edited storage, a half-written value, a blob from a
 * future version — all of them mean "assume nothing", never a throw on the way
 * to the first render.
 */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFERENCES;
  const o = parsed as Record<string, unknown>;
  // Field by field, checking the TYPE rather than truthiness: `"false"` and `0`
  // are somebody's corrupted value, not a considered choice, and coercing them
  // would silently honour it. Unknown keys are dropped by construction.
  return {
    showMapColumn:
      typeof o.showMapColumn === "boolean"
        ? o.showMapColumn
        : DEFAULT_PREFERENCES.showMapColumn,
    // Checked against the CATALOG, not just against `string`: a theme that was
    // removed, renamed, or never existed has to fall back to one that renders,
    // and `isThemeId` is the only thing that can tell the difference. The same
    // guard is what lets `themeById` promise it never returns undefined.
    themeId: isThemeId(o.themeId) ? o.themeId : DEFAULT_PREFERENCES.themeId,
  };
}

export function serializePreferences(prefs: Preferences): string {
  return JSON.stringify(prefs);
}

/**
 * The current preferences, cached at module scope.
 *
 * `getSnapshot` hands this exact object back, and that is load-bearing:
 * `useSyncExternalStore` compares snapshots by IDENTITY, so returning a freshly
 * parsed object per call would re-render forever. The cache is replaced only on
 * a write — from this tab, or from another one via the `storage` event.
 */
let current: Preferences = read();

function read(): Preferences {
  try {
    return parsePreferences(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled entirely. The app works, it just can't
    // remember anything.
    return DEFAULT_PREFERENCES;
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Preferences {
  return current;
}

function emit(next: Preferences): void {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Change one preference.
 *
 * Typed on `keyof Preferences`, so adding a preference needs a field and
 * nothing else — no new setter, no new action, no switch to forget a case in.
 *
 * The in-memory cache is updated even when the write fails, so a browser that
 * refuses storage still honours the toggle for the session and simply forgets it
 * on reload. Silently ignoring the click would be the worse failure.
 */
export function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): void {
  const next: Preferences = { ...current, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, serializePreferences(next));
  } catch {
    // Storage refused (quota, private mode). Fall through — see above.
  }
  emit(next);
}

// Two tabs are one app. Without this they disagree about the Map column until
// somebody reloads, which reads as the preference not having saved. The event
// only fires in the OTHER tabs, so there is no echo to guard against.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    emit(read());
  });
}

/** The preferences, re-rendering the caller when any of them change. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
