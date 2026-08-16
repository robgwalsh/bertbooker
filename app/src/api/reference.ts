// Reference data: the programs, currencies and airlines the Library draws, and
// the metered allowance the chip in the app bar reports.

import { req } from "./client";
import type {
  AirlineInfo,
  CurrencyInfo,
  ProgramInfo,
  QuotaPage,
} from "../../../shared/src/wire/index.js";

export const programs = () => req<ProgramInfo[]>("/programs");
export const currencies = () => req<CurrencyInfo[]>("/currencies");
export const airlines = () => req<AirlineInfo[]>("/airlines");

/** Remaining daily API allowance per metered source. A display, not a guard —
 *  only `alerts/budget.ts` reads the quota before spending. */
export const quota = () => req<QuotaPage>("/quota");
