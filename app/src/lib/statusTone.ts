// Status → tone, as pure data and one theme lookup. `StatusChip`, the component
// that draws it, stays with the finds table.
//
// NOTE: nothing imports any of this today. Kept rather than deleted because
// the vocabulary it encodes is the shared one (`SourceTaskStatus` plus the run
// statuses), and
// the next surface that reports a task's outcome should not re-derive which
// distinctions are worth a colour. Delete it if a second release goes by with
// no caller.

import type { Theme } from "@mui/material/styles";

/**
 * Status → tone, shared by the task grid and the run list so a `blocked` reads
 * the same everywhere.
 *
 * Deliberately not all-red: `empty` is a successful answer, and `blocked` is not
 * the same failure as `failed`. What each tone *is* comes from the live theme
 * (`toneColor`) rather than from a hex here — a status palette hardcoded to the
 * old near-black theme drew a mid-grey `empty` on Light+ and an off-brand teal
 * `ok` in every other theme.
 *
 * Four tones for ten statuses, because the distinctions worth drawing are
 * succeeded / nothing-there / refused / broken. The three shades of amber the
 * old map used for `blocked`, `challenged` and `timeout` were a difference you
 * could not see beside a chip that already spells the word.
 */
export type StatusTone = "success" | "error" | "warning" | "running" | "quiet" | "muted";

export const TASK_STATUS_TONE: Record<string, StatusTone> = {
  ok: "success",
  empty: "muted",
  failed: "error",
  blocked: "warning",
  challenged: "warning",
  timeout: "warning",
  skipped: "quiet",
  running: "running",
  partial: "warning",
  aborted: "muted",
};

export function toneColor(tone: StatusTone, theme: Theme): string {
  switch (tone) {
    case "success":
      return theme.palette.success.main;
    case "error":
      return theme.palette.error.main;
    case "warning":
      return theme.palette.warning.main;
    case "running":
      return theme.palette.secondary.main;
    // `skipped` is the one status nobody needs to notice: it is dimmer than
    // "we looked and found nothing", not just uncoloured.
    case "quiet":
      return theme.palette.text.disabled;
    default:
      return theme.palette.text.secondary;
  }
}
