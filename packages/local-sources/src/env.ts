import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` from the repo root into `process.env`, if it exists.
 *
 * There is no dotenv dependency in this repo and there doesn't need to be: the
 * format we care about is `KEY=value` lines. This exists because `INGEST_TOKEN`
 * is needed on *every* run against a deployed API, and "remember to export it
 * first" is the kind of instruction that gets forgotten right up until a run's
 * ingest is rejected after the gathering has already been paid for.
 *
 * Two rules:
 *   - **Never overwrite an already-set variable.** The shell (and CI) win, so a
 *     one-off `BERTBOOKER_API_URL=other npm run gather` still does what it says.
 *   - **Never throw.** A missing or unreadable `.env` is the normal case.
 *
 * `.env` is already in `.gitignore`. Keep it that way — this file's whole
 * purpose is holding a credential.
 */
export function loadEnv(): void {
  // packages/local-sources/src/env.ts -> repo root is three levels up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  let text: string;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes — a key pasted from a
    // dashboard often arrives wrapped.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
