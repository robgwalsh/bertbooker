/**
 * GET /api/d1-usage — the day's D1 row consumption against its ceiling.
 *
 * A sibling of `QuotaPage` rather than part of it. That one is a read of
 * `source_quota` and reports an allowance this app spends on purpose; this one
 * is Cloudflare's own accounting of what our queries cost, which the app can
 * only observe. They are polled separately so a slow answer from Cloudflare
 * cannot delay the seats.aero number.
 */
export interface D1Usage {
  /** 'YYYY-MM-DD', UTC — the day these totals cover, and the day they reset. */
  day: string;
  /** Unix ms at which the Worker asked. Cloudflare reports with a few minutes'
   *  lag, so this is when we looked, not when the rows were read. */
  observedAt: number;
  /** Rows read so far today, summed across every D1 database in the account —
   *  which is the scope the ceiling itself is measured over. */
  rowsRead: number;
  rowsWritten: number;
  /** The ceilings the app is drawing against, from `D1_ROWS_READ_LIMIT` /
   *  `D1_ROWS_WRITTEN_LIMIT` (defaults are the Workers Free daily numbers). */
  readLimit: number;
  writtenLimit: number;
}

/**
 * `usage` is ABSENT rather than zeroed whenever Cloudflare could not be asked —
 * no API token configured, a timeout, a non-200, or a body that did not parse.
 *
 * Absent and zero are the two answers that must never be confused: zero rows
 * read renders as a full allowance, which is the one reading that would say
 * "nothing to worry about" at exactly the moment nobody knows. The SPA draws
 * no chip for an absent meter. Same rule, and the same reasoning, as
 * `parseQuotaHeaders` in the seats.aero provider.
 */
export interface D1UsagePage {
  usage?: D1Usage;
}
