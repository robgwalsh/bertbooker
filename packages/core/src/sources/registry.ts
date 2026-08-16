import { PROGRAM_SEEDS } from "../data/programs.js";
import {
  isRunnable,
  type RunnableSource,
  type SourceDescriptor,
  type SourceRuntime,
} from "./types.js";

/**
 * The source catalogue.
 *
 * One place that knows what this app can gather from, what each source can
 * produce, and where each may run. Both runners read it: the Worker asks for
 * `runtime: "worker"`, the local CLI for `runtime: "local"`, so neither can
 * accidentally execute the other's sources.
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
 *    mix two services' rows under one `availability_snapshots.source`;
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
        `— availability_snapshots.program is a foreign key, so these would fail on write`,
    );
  }
  REGISTRY.set(source.id, source);
  return source;
}

/** Every registered source, optionally narrowed by where it may run. */
export function listSources(opts: { runtime?: SourceRuntime } = {}): SourceDescriptor[] {
  const all = [...REGISTRY.values()];
  const scoped = opts.runtime ? all.filter((s) => s.runtime === opts.runtime) : all;
  return scoped.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The sources a generic runner can actually execute in this runtime.
 *
 * The `isRunnable` filter is the safety property, not a convenience: a
 * descriptor-only source (seats.aero, driven by the Worker's own streaming
 * runner) must never be handed to the generic loop, which would find no `run`
 * and fail at the least useful moment.
 */
export function runnableSources(runtime: SourceRuntime): RunnableSource[] {
  return listSources({ runtime }).filter(isRunnable);
}

export function getSource(id: string): SourceDescriptor | undefined {
  return REGISTRY.get(id);
}

/** Resolve ids to runnable sources, rejecting anything unknown or not runnable
 *  in this runtime. Used by the CLI's `--sources` flag, where a silent miss
 *  would look exactly like "that source found nothing". */
export function resolveRunnable(ids: string[], runtime: SourceRuntime): RunnableSource[] {
  const available = runnableSources(runtime);
  return ids.map((id) => {
    const found = available.find((s) => s.id === id);
    if (found) return found;
    const known = available.map((s) => s.id).join(", ") || "(none)";
    const registered = REGISTRY.get(id);
    if (registered) {
      throw new SourceRegistrationError(
        `source "${id}" is registered but runs on "${registered.runtime}", not "${runtime}"`,
      );
    }
    throw new SourceRegistrationError(`unknown source "${id}" — known here: ${known}`);
  });
}

/** Test seam. Never call this from application code — the catalogue is meant to
 *  be assembled once, at import time. */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
}
