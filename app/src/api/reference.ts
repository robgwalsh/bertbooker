// Reference data: the programs, currencies and airlines the Library draws, and
// the metered allowance the chip in the app bar reports.

import { req } from "./client";
import type {
  AirlineInfo,
  CurrencyInfo,
  D1UsagePage,
  ProgramInfo,
  QuotaPage,
} from "../../../api/src/models/wire/index.js";

export const programs = () => req<ProgramInfo[]>("/programs");
export const currencies = () => req<CurrencyInfo[]>("/currencies");
export const airlines = () => req<AirlineInfo[]>("/airlines");

/** Remaining daily API allowance per metered source. A display, not a guard —
 *  only `alerts/budget.ts` reads the quota before spending. */
export const quota = () => req<QuotaPage>("/quota");

/** Today's D1 rows read and written against their daily ceilings — the other
 *  two chips beside the bolt. A separate call from `quota` because it waits on
 *  Cloudflare rather than on D1; see `api/src/endpoints/d1-usage-endpoints.ts`. Answers
 *  `{}` with no `usage` when Cloudflare could not be asked, which is the
 *  ordinary state locally. */
export const d1Usage = () => req<D1UsagePage>("/d1-usage");
