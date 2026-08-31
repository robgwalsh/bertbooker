import type { SourceQuota } from "./rows.js";

/** GET /api/quota. `today` travels with the payload so the SPA doesn't
 *  have to agree with the server about the UTC date to find today's row. */
export interface QuotaPage {
  today: string;
  quota: SourceQuota[];
}
