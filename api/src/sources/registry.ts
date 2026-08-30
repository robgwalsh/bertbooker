import { PROGRAM_SEEDS } from "../domain/programs.js";
import type { SourceDescriptor } from "./types.js";

/**
 * The source catalogue.
 *
 * One place that knows what this app can gather from and what each source can
 * produce. It holds one entry, seats.aero, and its live job is the validation
 * `registerSource` performs on the way in — see `sources/index.ts`.
 *
 * Registration is explicit rather than by directory scan — a source that isn't
 * named in `sources/index.ts` (or registered by an embedder) does not exist, and
 * that is easier to reason about than an import side effect.
 */
const REGISTRY = new Map<string, SourceDescriptor>();

export class SourceRegistrationError extends Error {}

/**
 * Add a source to the catalogue.
 *
 * Validates the two things that fail LATE and badly if wrong:
 *
 *  - a duplicate id, which would silently shadow one source with another and
 *    mix two services' rows under one `finds.source`;
 *  - a program not in `PROGRAM_SEEDS`, which is a foreign key on the snapshot
 *    row — so the mistake would surface as a write failing mid-run rather than
 *    as a bad registration.
 */
export function registerSource<T extends SourceDescriptor>(source: T): T {
  if (!source.id) throw new SourceRegistrationError("source id is required");
  const existing = REGISTRY.get(source.id);
  if (existing && existing !== source) {
    throw new SourceRegistrationError(`duplicate source id "${source.id}"`);
  }
  const known = new Set(PROGRAM_SEEDS.map((p) => p.code));
  const unknown = source.programs.filter((p) => !known.has(p));
  if (unknown.length) {
    throw new SourceRegistrationError(
      `source "${source.id}" declares unseeded programs: ${unknown.join(", ")} ` +
        `— finds.program is a foreign key, so these would fail on write`,
    );
  }
  REGISTRY.set(source.id, source);
  return source;
}

/** Every registered source, by id. */
export function listSources(): SourceDescriptor[] {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test seam. Never call this from application code — the catalogue is meant to
 *  be assembled once, at import time. */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
}
