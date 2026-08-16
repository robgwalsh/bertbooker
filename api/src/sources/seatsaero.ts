import {
  SEATSAERO_PROGRAMS,
  SEATSAERO_SOURCE_ID,
  SEATSAERO_HORIZON_DAYS,
} from "../providers/seatsaero.js";
import type { SourceDescriptor } from "./types.js";

export const seatsAeroSource: SourceDescriptor = {
  id: SEATSAERO_SOURCE_ID,
  label: "seats.aero",
  programs: SEATSAERO_PROGRAMS,
  horizonDays: SEATSAERO_HORIZON_DAYS,
};
