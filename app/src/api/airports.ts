import { req } from "./client";
import type {
  AirportGeo,
  AirportInfo,
  AirportName,
} from "../../../shared/src/wire/index.js";

/**
 * Search criteria shared by the airports table and the airports map.
 *
 * Client-only, and deliberately not part of the wire contract: it describes how
 * to BUILD a query string, not a shape either side sends. The Worker's end of it
 * is `airportFilter`, the one WHERE builder both routes share.
 */
export interface AirportSearchOpts {
  iataOnly?: boolean;
  scheduled?: boolean;
  continent?: string;
  country?: string;
  types?: string[];
  limit?: number;
}

function airportParams(q: string, opts?: AirportSearchOpts): string {
  const params = new URLSearchParams({ q });
  if (opts?.iataOnly) params.set("iataOnly", "1");
  if (opts?.scheduled) params.set("scheduled", "1");
  if (opts?.continent) params.set("continent", opts.continent);
  if (opts?.country) params.set("country", opts.country);
  if (opts?.types?.length) params.set("type", opts.types.join(","));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  return params.toString();
}

export const airports = (q: string, opts?: AirportSearchOpts) =>
  req<AirportInfo[]>(`/airports?${airportParams(q, opts)}`);

export const airportCountries = () =>
  req<{ country: string; count: number }[]>("/airports/countries");

/** Exact lookup for codes you already hold, in one round trip. Not a search —
 *  see the note on the route. Codes with no matching row come back absent. */
export const airportNames = (codes: string[]) =>
  req<AirportName[]>(`/airports/lookup?codes=${codes.join(",")}`);

// Same criteria as `airports`, slim columns, much higher cap — the map plots
// the whole matching set while the table lists only the top matches.
export const airportsGeo = (q: string, opts?: AirportSearchOpts) =>
  req<AirportGeo[]>(`/airports/geo?${airportParams(q, opts)}`);
