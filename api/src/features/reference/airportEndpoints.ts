import { Hono } from "hono";
import type { Env, Vars } from "../../bindings.js";
import { isLocalRequest } from "../../middleware/security.js";
import {
  selectAirportCountries,
  selectAirportGeo,
  selectAirports,
  selectAirportsByIata,
} from "../../db/airports.js";

/**
 * The Library's Airports pane, the origin/destination autocompletes, and the
 * coordinates the trip list's route maps draw from.
 *
 * `airports` is standalone reference data — ~72k public-domain OurAirports rows,
 * generated into `seed/airports.sql` by `npm run build:airports`. Nothing here
 * touches a find, a snapshot or a coverage row.
 *
 * ROUTE ORDER IS LOAD-BEARING within this file: `/countries`, `/geo` and
 * `/lookup` are registered before the bare `/api/airports`, and Hono runs
 * matching handlers in registration order.
 *
 * `/countries` and `/geo` power the Airports pane ONLY — the origin/destination
 * autocompletes and the trip list's route maps call plain `/api/airports` and
 * `/api/airports/lookup` respectively, never these two. The Airports pane
 * itself is dev-only (`LibraryPage.tsx` swaps it for an "offline" message
 * outside `import.meta.env.DEV`), so these two answer `not_found` off loopback
 * the same way `POST /api/alerts/run` does — no reason to serve a ~72k-row
 * country breakdown or world geo dump to a host that has no UI to show it.
 *
 * The queries themselves, and the WHERE builder the table and the map share,
 * are `db/airports.ts`. What is left here is the HTTP shape: the two host
 * guards, the limit clamps, and the code list `/lookup` accepts.
 */
export const airports = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- Airports: distinct countries (powers the country filter) ----
airports.get("/api/airports/countries", async (c) => {
  if (!isLocalRequest(c.req.url)) return c.json({ error: "not_found" }, 404);
  return c.json(await selectAirportCountries(c.env.DB));
});

// ---- Airports: slim geo rows for the current search (powers the map) ----
airports.get("/api/airports/geo", async (c) => {
  if (!isLocalRequest(c.req.url)) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100000, 1), 100000);
  return c.json(await selectAirportGeo(c.env.DB, (k) => c.req.query(k), limit));
});

// ---- Airports: resolve a set of IATA codes in one round trip ----
airports.get("/api/airports/lookup", async (c) => {
  const codes = [
    ...new Set(
      (c.req.query("codes") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{3}$/.test(s)),
    ),
    // A page of finds can hold 200 rows across many routes, and
    // every one of them names two to four airports. The cap is a guard against a
    // pathological query string, not a page size — set below what a real caller
    // asks for and the overflow is silent, which reads as a map that lost a
    // stop rather than as a truncated request. The read CHUNKS rather than
    // truncates, which is why this can sit above D1's 100-bind ceiling.
  ].slice(0, 400);
  return c.json(await selectAirportsByIata(c.env.DB, codes));
});

// ---- Airports: server-side ranked, multi-token search + filters ----
airports.get("/api/airports", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 200);
  return c.json(await selectAirports(c.env.DB, (k) => c.req.query(k), limit));
});
