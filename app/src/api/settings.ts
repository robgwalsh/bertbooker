import { req } from "./client";
import type {
  AlertRecipientInput,
  AlertRecipients,
} from "../../../api/src/models/wire/index.js";

export const alertRecipients = () => req<AlertRecipients>("/settings/recipients");

export const addAlertRecipient = (body: AlertRecipientInput) =>
  req<{ id: number }>("/settings/recipients", { method: "POST", body: JSON.stringify(body) });

export const deleteAlertRecipient = (id: number) =>
  req<{ ok: true }>(`/settings/recipients/${id}`, { method: "DELETE" });
