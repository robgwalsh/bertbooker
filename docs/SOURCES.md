# Sources — the plug-in contract

A **source** is anything that can answer *"what award space exists on this route,
on these dates"*. The app knows nothing else about where its data comes from: a
source produces `AvailabilityResult[]`, the ingest pipeline decides what that
means for the database, and every read goes through one CTE regardless of who
wrote the row.

The contract itself is `packages/core/src/sources/types.ts`, the catalogue is
`registry.ts`, and the two built-ins are `seatsaero.ts` and `pointsyeah.ts` in
the same directory. This document is the guide to them.

There are two sources today:

| id | runtime | what | doc |
|---|---|---|---|
| `seatsaero` | `worker` | A keyed, metered vendor API. Breadth: ~16 storable programs, a year out, for a handful of calls. | `docs/SEATS-AERO.md` |
| `pointsyeah` | `local` | A free aggregator, and the only source this app has for `cathay` and `eva`. | `docs/POINTSYEAH.md` |

There used to be more, and they read airlines' own booking sites. That is over —
`docs/HARVEST-POSTMORTEM.md` is why, and it is worth reading before you propose
a source that scrapes a carrier.

---

## 1. Runtime is evidence, not preference

The single most important field on a source is where it may run.

- **`worker`** — the service authenticates the **credential**. seats.aero wants
  its key and does not care that Cloudflare made the request, so the Worker calls
  it directly and a search needs no laptop awake.
- **`local`** — the service judges the **client**, or its posture against a
  datacenter IP has never been measured. It runs from `packages/local-sources`
  on a residential connection and POSTs to `/api/ingest/*`.

Neither runner can pick up the other's sources: the Worker asks the registry for
`runtime: "worker"`, `npm run gather` asks for `"local"`, and `resolveRunnable`
throws with an explanation rather than returning nothing.

**Setting this to `worker` without having measured it is the most expensive
mistake available here.** A source that quietly returns nothing in production is
indistinguishable from "there is no award space on this route" — which is the one
failure this whole application is built to prevent. PointsYeah is pinned to
`local` for exactly that reason: it is an anonymous JSON API and might well
answer a Worker, but nobody has probed it from the edge, so the field records
what is known rather than what is likely.

---

## 2. The contract

```ts
interface SourceDescriptor {
  readonly id: string;            // stored in availability_snapshots.source
  readonly label: string;
  readonly programs: string[];    // every one MUST exist in PROGRAM_SEEDS
  readonly horizonDays: number;
  readonly runtime: "worker" | "local";
}

interface RunnableSource extends SourceDescriptor {
  supports(q: SourceQuery): boolean;
  plan(q: SourceQuery, today: string): SourceTask[];      // PURE
  run(task: SourceTask, ctx: SourceCtx): Promise<SourceResult>;
  open?(ctx: SourceCtx): Promise<void>;
  close?(): Promise<void>;
}
```

**`id` is a permanent stored value.** It is written into
`availability_snapshots.source` and `search_coverage.source`, and prunes are
scoped per source. Renaming one without migrating both tables orphans every row
it ever wrote: nothing would clean them and they would read as current forever.
(Migration `0009` is what that migration looks like.)

**`programs` are foreign keys.** `registerSource` validates every entry against
`PROGRAM_SEEDS`, because otherwise the typo surfaces as a write failing mid-run
rather than as a bad registration.

**`supports` bows the source out** — false means no request is issued at all. A
single-program source declines a run filtered to other programs.

**`plan` is pure and must not touch the network.** It is called to price a run
before anyone decides to spend on it. Clamp to `horizonDays` here, not inside
`run`: a window entirely beyond the horizon must plan **zero** tasks, which reads
as "nothing to do". A task that ran and found nothing is a different claim — it
claims coverage.

### `SourceDescriptor` without `run` is a real option

seats.aero is descriptor-only. The Worker drives it through a specialised runner
(`workers/api/src/searchRun.ts`) that streams each HTTP call to the browser as it
lands, meters a per-request subrequest budget, and resumes across requests when
it runs out. Expressing that through a plain `run()` would push streaming
callbacks and call accounting into the interface and make every future source
carry seats.aero's shape.

The split is by **who drives the source**. `runnableSources()` filters on
`isRunnable`, so a descriptor-only entry can never reach the generic loop and
fail at the least useful moment. If you are adding a source, you almost certainly
want `RunnableSource`.

---

## 3. Three rules that keep the database honest

These are not style. Each one, broken, deletes real data.

### Throwing is the failure protocol

```ts
async run(task, ctx) {
  const res = await fetch(url);                  // may throw — good
  if (!res.ok) throw new Error(`http ${res.status}`);   // also good
  return { offers: parse(await res.json()) };
}
```

**Never return an empty result to signal failure.** `offers: []` means *"I looked
and there is no award space"* — it claims coverage, and coverage licenses
deleting the stored rows for that slice. The runner catches your throw,
classifies it (`classifyError` in `providers/transport.ts`), and continues with
the next task.

Only `ok` and `empty` claim coverage. `failed`, `blocked`, `challenged`,
`timeout` and `skipped` claim nothing, which is what stops a refused task from
destroying a real find.

### `coveredDates` is read off the payload, never off the plan

Services clamp windows near today and near their own horizon. If you asked for 60
days and the response only speaks to 30, say 30:

```ts
return { offers, coveredDates: datesActuallySeenInThePayload };
```

Over-claiming hard-deletes real finds. Under-claiming costs a stale row. **When
unsure, narrow it.**

### Gather wide, query narrow

`SourceQuery` carries no cabin, seat-count or currency filter, deliberately.
Anything filtered out at gather time is silently missing from the database for
every future question, including ones nobody has asked yet. Filter at read time.

`programs` is the one exception, and it is not a result filter — it selects which
sources bother to run.

---

## 4. Tasks

One task is whatever a source can do in a **single observable attempt**: one API
call, one date range. Small enough that its failure is informative, large enough
that the metadata isn't noise.

Each becomes a row in `search_tasks` with its own status, timing and error. That
is the property the design rests on: *"11 of 14 came back and three were
refused"* has to be queryable, not a log line.

`task.key` must be **derived from the work** — never from a counter or a clock.
`(run_id, source, task_key)` is UNIQUE, and the key is the idempotency guarantee
when a batch POST is retried.

A source is allowed to use one task for a whole run when its fan-out is genuinely
internal. PointsYeah does: it tiles its own date sub-windows and enriches each
result inside `search()`. The trade is stated in its docblock rather than hidden
— one task means one status, so "6 of 6 sub-windows returned" and "1 of 6" both
read as `ok`.

---

## 5. Registering

```ts
// packages/core/src/sources/index.ts
registerSource(seatsAeroSource);
registerSource(pointsYeahSource());
```

Registration is explicit rather than a directory scan: a source not named here
(or registered by an embedder after importing this module) does not exist.

The registry rejects a **duplicate id** rather than letting one source shadow
another — two services writing under one `availability_snapshots.source` would
make a prune delete the wrong data. Re-registering the *identical object* is a
no-op, so a double import is harmless.

---

## 6. Adding a source

1. **Probe first, with a control.** Establish that the data exists, logged out,
   and that you can get it from where you intend to run. Hold every variable
   fixed but one. An unpaired "it was blocked" is a rumour —
   `docs/HARVEST-POSTMORTEM.md` §6 is a list of what that costs.
2. **Set `runtime` to what you measured.** `local` unless you have specifically
   tested from a datacenter IP.
3. **Map its programs onto `PROGRAM_SEEDS`.** A program that is not seeded is not
   storable; add it to *both* `packages/core/src/data/programs.ts` and
   `seed/programs.sql`, which mirror each other.
4. **Establish `horizonDays` empirically.** Too high wastes calls on an empty
   horizon; too low silently caps the app's reach.
5. **Write `plan` pure and test it.** Windows past the horizon, windows straddling
   it, a one-day window.
6. **Write `run` against a captured fixture**, and let it throw. Redact
   credential-ish headers before committing the fixture, and read it before you
   do.
7. **Register it**, and run `npm run gather -- --sources <id> --from X --to Y
   --days 0-30 --dry` — which exercises plan, execute, classify and batch, and
   writes nothing.
8. **Then run it for real, twice.** The second run must write **zero** snapshots.
   That is write-on-change working, and it is the cheapest end-to-end proof this
   pipeline has that your ids, your hashes and your coverage claim all line up.

---

## 7. Where a source's output goes

Both runners converge on one function:

```
source.run()  →  AvailabilityResult[]  →  applyTask()  →  D1
```

`applyTask` (`packages/core/src/ingest/apply.ts`) runs per task, as work
completes — gathering can die halfway and the successful tasks are already
durable. Its order is the safety property: **read baseline → write changed
snapshots → prune → record coverage last**, so a crash under-claims rather than
over-claims.

Two things worth knowing because they constrain what a source may return:

- **`collapseBy`/`collapseBest` is required, not an optimisation.** The snapshot
  row is keyed (route, date, program, cabin); two itineraries for one slot would
  collide non-deterministically and the diff would report phantom changes every
  run.
- **Co-terminal answers are real and supported.** `AvailabilityResult` carries
  optional `origin`/`destination`, and one task may touch several route keys.
  The route is therefore part of the collapse key, the baseline read *and* the
  coverage claim.

The local runner adds the transport around that: `packages/local-sources/src/
runner.ts` plans, paces, batches and POSTs to `/api/ingest/*` with an
`X-Ingest-Token`; `cli.ts` is `npm run gather`.

---

## See also

- `docs/SEATS-AERO.md` — the Worker-side source, in full.
- `docs/POINTSYEAH.md` — the local source, in full.
- `docs/ALERTS.md` — the scheduled sweep, which drives the Worker source with
  nobody at the keyboard.
- `docs/HARVEST-POSTMORTEM.md` — the sources that are gone, and why.
