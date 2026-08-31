import { Hono } from "hono";
import { AIRLINE_DIRECTORY } from "../models/airline.js";
import { CURRENCIES } from "../models/program.js";
import { selectActivePrograms } from "../db/programs.js";
import type { Env, Vars } from "../bindings.js";
import type { ProgramInfo } from "../../../shared/src/wire/index.js";

export const reference = new Hono<{ Bindings: Env; Variables: Vars }>();

reference.get("/api/currencies", (c) => c.json(CURRENCIES));

reference.get("/api/airlines", (c) => c.json(AIRLINE_DIRECTORY));

reference.get("/api/programs", async (c) => {
  const results = await selectActivePrograms(c.env.DB);
  const body: ProgramInfo[] = results.map((r) => ({
    ...r,
    transfer_partners: JSON.parse(String(r.transfer_partners)) as ProgramInfo["transfer_partners"],
  }));
  return c.json(body);
});
