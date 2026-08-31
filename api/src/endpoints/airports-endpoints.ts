import { Hono } from "hono";
import type { Env, Vars } from "../bindings.js";
import { isLocalRequest } from "../middleware/security.js";
import {
  selectAirportCountries,
  selectAirportGeo,
  selectAirports,
  selectAirportsByIata,
} from "../db/airports.js";

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
  ].slice(0, 400);
  return c.json(await selectAirportsByIata(c.env.DB, codes));
});

// ---- Airports: server-side ranked, multi-token search + filters ----
airports.get("/api/airports", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 200);
  return c.json(await selectAirports(c.env.DB, (k) => c.req.query(k), limit));
});
