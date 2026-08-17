# Sources, and the contract that keeps the database honest

A **source** is anything that can answer *"what award space exists on this route,
on these dates"*. The app knows nothing else about where its data comes from: a
source produces `AvailabilityResult[]`, the ingest pipeline decides what that
means for the database, and every read goes through one CTE regardless of who
wrote the row.

The contract is `api/src/sources/types.ts`, the catalogue is `registry.ts`,
and the one entry is `seatsaero.ts` in the same directory.

There is one source:

| id | what | doc |
|---|---|---|
| `seatsaero` | A keyed, metered vendor API. Breadth: ~16 storable programs, a year out, for a handful of calls. | `docs/SEATS-AERO.md` |

## 1. The contract

```ts
interface SourceDescriptor {
  readonly id: string;            // stored in availability_snapshots.source
  readonly label: string;
  readonly programs: string[];    // every one MUST exist in PROGRAM_SEEDS
  readonly horizonDays: number;
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
scoped per source. Two things follow:

- Renaming an id without migrating both tables orphans every row it ever wrote:
  nothing would clean them and they would read as current forever.
- **Retiring a source without deleting its rows does the same thing.** Delete the
  code and nothing is left with the authority to prune what it wrote. Retiring a
  source is therefore a migration that deletes its rows, not just a code
  deletion — `migrations/0002_drop_pointsyeah.sql` is the pattern to follow.

**`programs` are foreign keys.** `registerSource` validates every entry against
`PROGRAM_SEEDS`, because otherwise the typo surfaces as a write failing mid-run
rather than as a bad registration. Since `sources/index.ts` registers at import
time, that check runs on every Worker boot — it is the registry's one live job.

**`supports` bows the source out** — false means no request is issued at all. A
single-program source declines a run filtered to other programs.

**`plan` is pure and must not touch the network.** It is called to price a run
before anyone decides to spend on it. Clamp to `horizonDays` here, not inside
`run`: a window entirely beyond the horizon must plan **zero** tasks, which reads
as "nothing to do". A task that ran and found nothing is a different claim — it
claims coverage.

### `SourceDescriptor` without `run` is the only shape in use

seats.aero is descriptor-only. The Worker drives it through a specialised runner
(`api/src/search/run.ts`) that streams every HTTP call to the browser as it lands,
meters a per-request subrequest budget, and resumes across requests when it runs
out. Expressing that through a plain `run()` would push streaming callbacks and
call accounting into the interface and make every future source carry
seats.aero's shape.

The split is by **who drives the source**. `isRunnable` narrows a catalogue entry
to one a generic loop could execute, and nothing satisfies it today — the
interface is kept as the seam a second source would implement, and because the
docblock on `run` states the failure protocol below.

---

## 2. Three rules that keep the database honest

These are not style. Each one, broken, deletes real data. **None of them is about
source count** — they are properties of `applyTask`, and seats.aero depends on
every one.

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
`timeout` and `skipped` claim nothing, which is what stops a refused seats.aero
chunk deleting seats.aero's own stored finds.

### `coveredDates` is read off the payload, never off the plan

Services clamp windows near today and near their own horizon, and paginated
answers truncate. If you asked for 60 days and the response only speaks to 30,
say 30:

```ts
return { offers, coveredDates: datesActuallySeenInThePayload };
```

Over-claiming hard-deletes real finds. Under-claiming costs a stale row. **When
unsure, narrow it.** `docs/SEATS-AERO.md` §8 is this rule applied to a real
truncating endpoint.

### Gather wide, query narrow

`SourceQuery` carries no cabin, seat-count or currency filter, deliberately.
Anything filtered out at gather time is silently missing from the database for
every future question, including ones nobody has asked yet. Filter at read time.

`programs` is the one exception, and it is not a result filter — it selects which
sources bother to run.

---

## 3. Tasks

One task is whatever a source can do in a **single observable attempt**: one API
call, one date range. Small enough that its failure is informative, large enough
that the metadata isn't noise.

Each becomes a row in `search_tasks` with its own status, timing and error. That
is the property the design rests on: *"11 of 14 came back and three were
refused"* has to be queryable, not a log line. seats.aero is a genuinely
multi-task source — 90-day chunks, each of which can paginate — so this matters
more for it than it ever did for an aggregator that answered in one shot.

`task.key` must be **derived from the work** — never from a counter or a clock.
`(run_id, source, task_key)` is UNIQUE, and the key is what makes re-applying a
task an update rather than a duplicate.

---

## 4. Where a source's output goes

```
source.run()  →  AvailabilityResult[]  →  applyTask()  →  D1
```

`applyTask` (`api/src/ingest/apply.ts`) runs per task, as work completes —
gathering can die halfway and the successful tasks should already be durable. Its
order is the safety property: **read baseline → write changed snapshots → prune →
record coverage last**, so a crash under-claims rather than over-claims.

Four things worth knowing because they constrain what a source may return:

- **`collapseBy`/`collapseBest` is required, not an optimisation.** The snapshot
  row is keyed (route, date, program, cabin); two itineraries for one slot would
  collide non-deterministically and the diff would report phantom changes every
  run.
- **Co-terminal answers are real and supported.** A source can return SFO→**HND**
  itineraries for an SFO→NRT search, and the good space is often on the airport
  nobody asked for. `AvailabilityResult` carries optional `origin`/`destination`,
  and one task may touch several route keys. The route is therefore part of the
  collapse key, the baseline read *and* the coverage claim — miss any one and you
  either merge two real finds into one, rewrite rows every run, or leave rows
  prunable-but-never-marked-checked.
- **Write-on-change is keyed off the STORED `raw_hash`, not a recomputed one.**
  Enrichment replaces a summary's synthetic segment with real legs, and
  `hashResult` folds segments in — so a recomputed baseline would differ from the
  identical summary arriving next and throw the enrichment away on every search,
  forever.
- **A re-run that changes nothing upstream writes ZERO rows.** That is the
  cheapest end-to-end proof this pipeline has that a source's ids, hashes and
  coverage claim all line up.

---

## 5. Adding a source

1. **Probe first, from the edge, with a control.** Establish that the data
   exists, logged out, and that a Cloudflare IP can get it. Hold every variable
   fixed but one. An unpaired "it was blocked" is a rumour —
   `docs/HARVEST-POSTMORTEM.md` §6 is a list of what that costs. A source that
   fails this test does not get added; see §1.
2. **Map its programs onto `PROGRAM_SEEDS`.** A program that is not seeded is not
   storable; add it to *both* `api/src/domain/programs.ts` and
   `seed/programs.sql`, which mirror each other.
3. **Establish `horizonDays` empirically.** Too high wastes calls on an empty
   horizon; too low silently caps the app's reach.
4. **Write `plan` pure and test it.** Windows past the horizon, windows
   straddling it, a one-day window.
5. **Write `run` against a captured fixture**, and let it throw. Redact
   credential-ish headers before committing the fixture, and read it before you
   do.
6. **Register it** in `api/src/sources/index.ts`.
7. **Then run it for real, twice.** The second run must write **zero** snapshots
   (§5).
8. **Plan its removal before you need it.** A source is a permanent value in two
   tables. Whatever adds one should know what deleting its rows would look like.

---

## See also

- `docs/SEATS-AERO.md` — the one source, in full.
- `docs/ALERTS.md` — the scheduled sweep, which drives it with nobody at the
  keyboard.
- `docs/HARVEST-POSTMORTEM.md` — the sources that are gone, and why.
