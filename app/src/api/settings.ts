import { req } from "./client";
import type {
  AlertRecipientInput,
  AlertRecipients,
  AlertSettings,
  AlertSettingsInput,
} from "../../../api/src/models/wire/index.js";

export const alertRecipients = () => req<AlertRecipients>("/settings/recipients");

export const addAlertRecipient = (body: AlertRecipientInput) =>
  req<{ id: number }>("/settings/recipients", { method: "POST", body: JSON.stringify(body) });

export const deleteAlertRecipient = (id: number) =>
  req<{ ok: true }>(`/settings/recipients/${id}`, { method: "DELETE" });

/** The current value comes back on `alertSchedule` as `budget.allowancePct`,
 *  with the budget it produces, so there is no matching GET here. */
export const setAlertAllowance = (body: AlertSettingsInput) =>
  req<AlertSettings>("/settings/alerts", { method: "PUT", body: JSON.stringify(body) });
