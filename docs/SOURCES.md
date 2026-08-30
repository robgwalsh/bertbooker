# Sources, and the contract that keeps the database honest

A **source** is anything that can answer *"what award space exists on this route,
on these dates"*. The app knows nothing else about where its data comes from: a
source produces `AvailabilityResult[]` and the ingest pipeline decides what that
means for the database.

The contract is `api/src/sources/types.ts`, the catalogue is `registry.ts`, and
the one entry is `seatsaero.ts` in the same directory.

There is one source:

| id | what | doc |
|---|---|---|
| `seatsaero` | A keyed, metered vendor API. Breadth: ~16 storable programs, a year out, for a handful of calls. | `docs/SEATS-AERO.md` |

## 1. The contract

```ts
interface SourceDescriptor {
  readonly id: string;            // registry key and log label — NOT stored
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

**`id` is not a stored value, and that is a deliberate change.** `finds` carries
no provenance column. There is one source; a second one is a schema change rather
than a config change, and that trade is the reason this is simple:

- Renaming the id costs nothing. No row carries it.
- **Retiring the source is deleting the rows in `finds`**, not migrating a column
  full of its name. There is nothing to orphan.

What a second source would cost, stated plainly so the decision is made with open
eyes: `finds` is keyed `(origin, destination, flight_date, program, cabin)`, so
two sources answering about one slot collide. Supporting both means either
merging before the write — losing one claim — or adding `source` to the key,
which is a new table and a re-fetch. Neither is hard; neither is free.

**`programs` are foreign keys.** `registerSource` validates every entry against
`PROGRAM_SEEDS`, because otherwise a typo surfaces as a write failing mid-run
rather than as a bad registration. Since `sources/index.ts` registers at import
time, that check runs on every Worker boot — it is the registry's one live job,
and it is the reason that import exists at all.

**`supports` bows the source out** — false means no request is issued.

**`plan` is pure and must not touch the network.** It is called to price a run
before anyone decides to spend on it. Clamp to `horizonDays` here, not inside
`run`: a window entirely beyond the horizon must plan **zero** tasks, which reads
as "nothing to do". A task that ran and found nothing is a different claim — it
claims coverage.

### `SourceDescriptor` without `run` is the only shape in use

seats.aero is descriptor-only. The Worker drives it through a specialised runner
(`api/src/features/search/run.ts`) that streams every HTTP call to the browser as it lands,
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
  const res = await fetch(url);                        // may throw — good
  if (!res.ok) throw new Error(`http ${res.status}`);  // also good
  return { offers: parse(await res.json()) };
}
```

**Never return an empty result to signal failure.** `offers: []` means *"I looked
and there is no award space"* — it claims coverage, and coverage licenses
deleting the stored rows for that slice. The runner catches your throw,
classifies it (`classifyError` in `providers/transport.ts`), and continues with
the next task.

Only `ok` and `empty` claim coverage. `failed`, `blocked`, `challenged`,
`timeout` and `skipped` claim nothing, which is what stops a refused chunk
deleting the finds it never looked at.

### `coveredDates` is read off the payload, never off the plan

Services clamp windows near today and near their own horizon, and paginated
answers truncate. If you asked for 60 days and the response only speaks to 30,
say 30:

```ts
return { offers, coveredDates: datesActuallySeenInThePayload };
```

Over-claiming hard-deletes real finds. Under-claiming costs a stale row. **When
unsure, narrow it.** `docs/SEATS-AERO.md` §7 is this rule applied to a real
truncating endpoint.

### Gather wide, query narrow

`SourceQuery` carries no cabin, seat-count or currency filter, deliberately.
Anything filtered out at gather time is silently missing from the database for
every future question, including ones nobody has asked yet. Filter at read time —
`shared/src/match/routeMatch.ts` is where that happens.

`programs` is the one exception, and it is not a result filter — it selects which
sources bother to run.

---

## 3. Tasks

One task is whatever a source can do in a **single observable attempt**: one API
call, one date range. Small enough that its failure is informative, large enough
that the metadata isn't noise.

**A task is not stored.** There was a `search_tasks` table holding a row per
call, with its status, timing, final URL and captured response metadata. Nothing
ever read a row back out of it, while it cost four rows written per API call
against a 100,000-a-day budget. What a person actually needs to debug a bad call
— the request, the response, the timing — is streamed to the browser as the
search runs, which is where they are already looking; a reload loses it, and that
has never been the complaint.

What survives on the `runs` row is the shape of the outcome: `tasks_planned`,
`tasks_ok`, `tasks_failed`. That is enough to answer *"11 of 14 came back and
three were refused"*, and **it is load-bearing beyond display**: `tasks_ok +
tasks_failed` is the index a resumed pass starts the plan from.

Task order must therefore be **stable across plans of the same route**. A resumed
pass indexes into the plan by count, so a plan that reorders between passes would
re-run some tasks and silently skip others. `api/src/domain/routing.ts` sorts its
airport lists for exactly this reason.

---

## 4. Where a source's output goes

```
source.run()  →  AvailabilityResult[]  →  applyTask()  →  finds
```

`applyTask` (`api/src/features/search/apply.ts`) runs per task, as work completes —
gathering can die halfway and the successful tasks should already be durable. Its
order is the safety property: **read baseline → write what changed → prune**, so
a crash under-claims rather than over-claims. The claim itself is
`coverageSlices(task)`, decided before anything is written and never stored;
`prunable()` is its only consumer.

Four things worth knowing because they constrain what a source may return:

- **`collapseBy` is required, not an optimisation.** The row is keyed
  (route, date, program, cabin); two itineraries for one slot would collide
  non-deterministically and the diff would report phantom changes every run.
- **Co-terminal answers are real and supported.** A source can return SFO→**HND**
  itineraries for an SFO→NRT search, and the good space is often on the airport
  nobody asked for. `AvailabilityResult` carries its own `origin`/`destination`,
  and one task may touch several routes. The route is therefore part of the
  collapse key and of the baseline read — miss either and you merge two real
  finds into one, or rewrite rows every run because a substituted airport was
  never in the baseline to compare against.
- **Write-on-change is keyed off the STORED `raw_hash`, not a recomputed one.**
  Enrichment replaces a summary's synthetic segment with real legs, and
  `hashResult` folds segments in — so a recomputed baseline would differ from the
  identical summary arriving next and throw the enrichment away on every search,
  forever.
- **A re-run that changes nothing upstream writes ZERO rows.** That is the
  cheapest end-to-end proof this pipeline has that a source's ids and hashes line
  up, and it is now literally true: nothing else writes on the ingest path.

### What a write costs

`finds` is `WITHOUT ROWID` with no secondary index, so one changed find is **one
row written**. That is the budget this pipeline is designed around — D1's free
tier allows 100,000 rows written a day and bills an index entry as a row — and it
is why adding an index to that table is a trade to argue rather than a tidy-up.

---

## 5. Adding a source

1. **Probe first, from the edge, with a control.** Establish that the data
   exists, logged out, and that a Cloudflare IP can get it. Hold every variable
   fixed but one. An unpaired "it was blocked" is a rumour. A source that fails
   this test does not get added; carriers refuse datacenter IPs and no amount of
   header-tuning changes that — see the host rule in `CLAUDE.md`.
2. **Decide what it does to `finds` first.** One source per slot is currently
   assumed. See §1.
3. **Map its programs onto `PROGRAM_SEEDS`.** A program that is not seeded is not
   storable; add it to *both* `api/src/domain/programs.ts` and
   `seed/programs.sql`, which mirror each other.
4. **Establish `horizonDays` empirically.** Too high wastes calls on an empty
   horizon; too low silently caps the app's reach.
5. **Write `plan` pure and test it.** Windows past the horizon, windows
   straddling it, a one-day window. Order stably — see §3.
6. **Write `run` against a captured fixture**, and let it throw. Redact
   credential-ish headers before committing the fixture, and read it before you
   do.
7. **Register it** in `api/src/sources/index.ts`.
8. **Then run it for real, twice.** The second run must write **zero** rows.

---

## See also

- `docs/SEATS-AERO.md` — the one source, in full.
- `docs/ALERTS.md` — the scheduled sweep, which drives it with nobody at the
  keyboard.
