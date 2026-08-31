/**
 * A GATHERING RUN's bookkeeping — what a pass accumulated, what the day has
 * left, and what came of a digest.
 *
 * Three small shapes that would each be alone in a file, kept together because
 * they are one subject: the paperwork a run leaves behind. None of them is a
 * find; all of them exist so a run that went wrong is visible afterwards, which
 * matters most for the one that runs with nobody watching.
 *
 * The statements are `db/runs.ts`, `db/sourceQuota.ts` and
 * `db/alertDeliveries.ts`. What the Alerts tab renders — `Run`, `SourceQuota`,
 * `AlertDelivery` — are WIRE types (`api/src/models/wire/rows.ts`).
 */

/** What a pass accumulated, written onto the `runs` row by `finishRun`.
 *
 *  These ACCUMULATE across passes: a resumed run must not overwrite what the
 *  previous one recorded, because `tasks_ok + tasks_failed` is the index the
 *  next pass starts from. */
export interface SearchTotals {
  ok: number;
  failed: number;
  offers: number;
  written: number;
  pruned: number;
  calls: number;
}

/** The stored quota row for one (source, day), plus what today's runs report
 *  spending. Raw: what the two numbers MEAN is `decideSweep`'s question, and it
 *  is asked in `features/alerts/budget.ts` — the one place that reads a quota
 *  before spending. */
export interface BudgetRows {
  quota?: { remaining: number; limit_calls: number | null; observed_at: number };
  spent: number;
}

/** One attempt to deliver a digest, INCLUDING the ones that never went out. No
 *  failure email exists, so the row is the only trace a dropped digest leaves,
 *  and `skipped` ("we never tried") must stay distinguishable from `failed`
 *  ("they refused"). */
export interface DeliveryRecord {
  sweepId: string;
  recipient: string;
  status: string;
  subject: string;
  changeCount: number;
  providerMessageId: string | null;
  error: string | null;
}
