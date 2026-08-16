# PointsYeah

> **This is not an official or documented API.** PointsYeah publishes no public
> API and this integration is not affiliated with or endorsed by them. What is
> described below is an anonymous JSON endpoint observed in the browser, called
> with browser-shaped headers. It may change or stop working at any time without
> notice, and if you run this you are responsible for your own use of it under
> PointsYeah's terms of service. Nothing here bypasses authentication, payment or
> an access control — the endpoint takes no credential — but "it answers" is not
> the same as "you are entitled to call it", and that judgement is yours.
>
> The other source, seats.aero, is the opposite case: a paid Partner API used as
> documented. See `docs/SEATS-AERO.md`.
>
> If you would rather not run this source, it is not load-bearing: drop
> `pointsYeahSource()` from the registry in `packages/core/src/sources/index.ts`.
> The cost is the `cathay` and `eva` programs, for which it is the only source
> (§1), and a `runtime: "local"` gatherer you then have no use for.

The aggregator source: `packages/core/src/providers/pointsyeah.ts` (the wire
handling) and `packages/core/src/sources/pointsyeah.ts` (the plug-in), registered
as **`pointsyeah`** with `runtime: "local"`.

It is one of two sources this app has, and the only one that does not run on the
Worker. `docs/SOURCES.md` is the contract it implements.

---

## 1. What it is, and why it is still here

PointsYeah's search backend is an **anonymous JSON API** — no auth, no cookie,
confirmed by capturing a real request. One POST returns award results across ~20
mileage programs, each carrying a `transfer[]` list of the card currencies that
can book it.

It answers honestly, from a plain fetch, with breadth no single carrier adapter
could match. What it cannot do is see far — its live search materialises roughly
two and a half months of availability, so it can never be the whole story (§3).
seats.aero is the wide-angle lens; this is the one that sees what seats.aero
does not carry at all.

**It is the only source for two seeded programs.** `cathay` and `eva` exist in
`PROGRAM_SEEDS` and seats.aero carries no source for either under any spelling
tried (see `docs/SEATS-AERO.md`). PointsYeah maps `CX` and `BR`, so it is the
only way those two ever appear in the database. (`ana` is seeded and mapped by
nothing — it is simply not obtainable today.)

That is why it survived the retirement of the scraped sources
(`docs/HARVEST-POSTMORTEM.md`): it is not a carrier's own site, nothing about it
was ever blocked, and dropping it would silently remove two programs from the
app.

---

## 2. How it is wired

`pointsYeahSource()` (`packages/core/src/sources/pointsyeah.ts`) is a
`RunnableSource` wrapping `PointsYeahProvider`, and it plans **one task per run**.

That is the escape hatch for a source whose fan-out is genuinely internal:
PointsYeah plans its own date tiling, clamps to its own horizon, and enriches
each kept result from a detail URL, all inside `search()`. Decomposing that into
observable tasks would mean rewriting it for metadata nothing currently needs.

**The trade is stated plainly: one task means one status for the whole source.**
"6 of 6 chunks returned" and "1 of 6 returned" both read as `ok` in
`search_tasks`. That is acceptable for an aggregator that either answers or
doesn't; it would not be acceptable for a source that can be refused per request,
which is why the contract supports many tasks even though this one uses a single
task. The per-chunk detail is not lost, only demoted: it goes to `ctx.log`, which
the runner captures into that run's `search_logs` rows.

### Why `runtime: "local"`

This records a measurement that has **not** been made. PointsYeah is an anonymous
JSON API and might well answer a Cloudflare Worker, but it has only ever been
called from a residential connection and nothing here has tested otherwise.

Promoting it to `worker` is a one-line change once somebody probes it from the
edge — and a bad idea until they do, because a source that quietly returns
nothing is indistinguishable from a route with no award space. `docs/SOURCES.md`
§1 is the general form of that argument.

---

## 3. Three server limits, and the plan they force

All three were discovered empirically, and each one shapes the strategy:

1. **A rolling ~80-day horizon from *today*.** Any request whose start or end
   lands beyond it returns nothing. PointsYeah's live search only materialises
   ~2.5 months; the far-future dates visible on their own site come from a
   separate curated cache, not from this date-searchable endpoint. So the tracked
   window is clamped to `[max(today, start), min(end, today + HORIZON_DAYS)]`
   with `HORIZON_DAYS = 70` — under the true cutoff, so the last chunk never
   falls off the edge.
2. **A ~50-result cap per request, with pagination params ignored.** There is no
   second page to ask for, so the only defence is asking for less at a time:
   `CHUNK_DAYS = 20` sub-windows, capped at `MAX_CHUNKS = 6`. A chunk that comes
   back with exactly `SEARCH_PAGE_CAP` rows **may be truncated**, and says so in
   the run log.
3. **A ~80-day maximum span per request.** Moot once the window is clamped and
   chunked — but it is why one giant request cannot replace the chunking.

A year-long tracked route therefore still works; it simply picks up dates as they
roll into the horizon on each search. There is nothing to fix here — the data does
not exist further out.

The endpoint is **`/v2/live/explorer/search`**, not the older `recommend`
explorer. `recommend` returns a sparse curated handful of dates and **ignores any
date-range input**, so a narrow tracked window usually matched none of them.
`search` honours `start_date`/`end_date`, at the cost of the three limits above.

---

## 4. The request

A POST per sub-window, with `content-type: text/plain;charset=UTF-8` and browser
`origin`/`referer`/`user-agent` headers — the shape a real request had when
captured.

- **Every bank is requested** (`Chase`, `Capital One`, `Bilt`, `Citi`, `Amex`,
  `Wells Fargo`), so `transfer[]` comes back complete and `bookableWith` is
  derived from a full list rather than a pre-filtered one. Amex/Wells Fargo space
  still surfaces and resolves to "not bookable by us", which is a fact worth
  storing rather than a row worth hiding.
- **Every cabin is requested.** Narrowing happens later.
- **`seats: 1`.** Gather wide, query narrow — the seat threshold is applied
  client-side.
- `today` is sent in the body and is **injectable** (`PointsYeahOptions.today`),
  so a caller in a clock-less context can supply it and tests are deterministic.

`fetchImpl` is the transport seam: it defaults to global `fetch` and exists so a
blocked request could be reissued through a different transport without touching
the parser.

---

## 5. Normalizing

`normalizePointsYeah` is pure and unit-tested against
`__fixtures__/pointsyeah-explorer.json`.

**It reads either envelope**: `{ results }` (the `search` endpoint) or
`{ data: { routes } }` (the old `recommend` one). Keeping both costs one `??` and
means a capture from either endpoint parses.

### The program map is IATA codes, not program names

`POINTSYEAH_PROGRAM_MAP` keys on the **airline IATA code** in the response's
`program` field — `AC`, `AV`, `TK`, `UA`, `SQ`, `AF`/`KL`, `VS`,
`BA`/`IB`/`EI`/`QR`, `AA`, `AS`, `CX`, `QF`, `EK`, `EY`, `BR`, `B6` — mapping 20
codes onto 16 of our `programs.code` values. Four of them collapse into `avios`
and two into `flyingblue`, which is correct: one currency pool, one program code.

**An unmapped program is dropped, and that is FK protection, not fastidiousness.**
`availability_snapshots.program` is a foreign key, so an unmapped code would fail
the insert rather than merely be uninteresting. The same rule applies to cabins:
`CABIN_MAP` covers the four PointsYeah spells and anything else is dropped, never
guessed.

### `bookableWith` comes from the response

Unlike every other source in this repo — where `bookableWith` is derived from our
own transfer-partner seed data via `currenciesForProgram` — PointsYeah's own
`transfer[]` is the input. `TRANSFER_MAP` lists only the couple's four
currencies, so Amex and Wells Fargo entries fall out and a result reachable only
through them arrives with an empty `bookableWith`. (See §8 — as registered, such
a result is currently dropped before it reaches the database.)

### Other field notes

- `tax` is in **dollars** and is multiplied into `cashFeesCents`. It is an award
  tax, never a cash fare: PointsYeah results never carry `cashPriceCents`.
- `sourceFetchedAt` prefers the row's own `updated_at`, then `created_at`, then
  the fetch time — the same "the source's own timestamp is the honest one" rule
  the rest of the pipeline holds, because `findsCte` picks winners by freshest
  `source_fetched_at`.
- `segments` starts as a **single placeholder leg** (origin → destination,
  carrier = the IATA program code). The list endpoint has no itinerary; the real
  legs arrive in §6, and if they never do, the placeholder is what gets stored.
- `stops` is taken from the row and `isDirect` derived from it.

---

## 6. Detail enrichment

The list endpoint omits the itinerary, but each result carries a `detail_url` —
a static CloudFront JSON feed with the full breakdown: real segments (flight
numbers, times, aircraft), a total duration, and a **deep link to book on the
program's own award search**.

`enrichWithDetail` fetches those for the results that survived filtering, and it
is **best-effort by design**:

- Capped at `MAX_DETAIL_FETCHES = 60` per search, so a broad "any cabin" route
  can't fan out into hundreds of requests. When the cap bites it is logged with
  the true total.
- Any failure — non-OK, unparseable, thrown — leaves the summary-level result
  intact. The find is still stored and still shown; it just has no per-leg
  breakdown or booking link.
- Only non-empty values overwrite: segments replace the placeholder only when
  there is at least one, and `stops`/`isDirect` update together.

`parseDetail` is pure and takes the **first** offered routing — they share the
same booking link — deriving `stops` from the segment count.

The pairing back to the right result depends on a documented property of
`filterForParams`: **it returns the same object references it was given**, so a
`Set` membership test after filtering identifies survivors. Do not map or clone
in that function; PointsYeah's detail pass is what breaks if you do.

---

## 7. Coverage

`coverage()` claims **every program in the map**, over the window that actually
survived the horizon clamp — never over the tracked window as requested. This is
what lets the pipeline tell "this space vanished" apart from "we never looked
there"; without it, a find beyond the ~70-day horizon would be hard-deleted as
stale on the first search that did not reach it.

`providerSource` then flattens that claim into discrete dates and **re-clamps it
to the requested window**. Providers are trusted to stay inside it, but a stray
date would otherwise widen the claim through the returned-offers fold-in — the
one direction that deletes data.

The standing invariant applies: coverage must be a **superset** of what `search()`
returned, and when in doubt, under-claim. Over-claiming hard-deletes real finds;
under-claiming costs a stale row.

---

## 8. Failure semantics, and one caveat

Sub-windows are fetched with `Promise.allSettled` and merged. **One failed chunk
does not sink the search** — the successful ones are real data. If *every* chunk
fails, `search()` **throws**, which is the failure protocol: the task is recorded
as `failed`, claims no coverage, and therefore cannot prune. Returning an empty
array there would mean "I looked and there is nothing", which licenses a delete.

Note the granularity cost from §2: a run where 5 of 6 chunks failed still lands
as one `ok` task. The evidence is in `search_logs`, not in the task row.

### The `bookableOnly` caveat

`PointsYeahProvider`'s constructor takes `bookableOnly`, **defaulting to `true`**,
and `search()` passes it to `filterForParams`. The registry constructs
`new PointsYeahProvider()` with no options, so that default is what runs.

The effect: a result whose `transfer[]` resolves to **no** currency the couple
holds is dropped *before it is stored*, not merely hidden at query time. That is a
gather-time filter, and it sits in tension with **gather wide, query narrow** —
the rule that anything dropped at gather time is missing from the database for
every future question. It also differs from how the same situation is handled
elsewhere: a seats.aero find with an empty `bookableWith` *is* stored, because a cash
fare can still make that seat reachable through a card's travel portal.

It is recorded here rather than silently changed: the fix is one argument where
`pointsYeahSource()` constructs the provider, and it would widen what future runs
store without touching what is already there.

---

## 9. Running and testing it

```sh
npm -w @bertbooker/core exec vitest run src/providers/pointsyeah.test.ts
                                   # pure: normalize, filter, parseDetail
npm run gather -- --from SEA --to NRT --days 0-60 --dry
npm run gather -- --from SEA --to NRT --days 0-60
```

Keep the window inside ~70 days or the source will decline the run outright and
log why. A run whose whole window is beyond the horizon plans **zero tasks** and
is skipped with `nothing in horizon` — not a failure, and not an empty result
either.

Because the useful signals live in the log rather than in task rows, `--verbose`
is worth using here: the horizon clamp, the `raw -> after filter` count, a chunk
hitting the 50-result cap, and the detail-fetch cap all arrive as log lines.

A large gap between `raw` and `after filter` is usually the route's own
cabin/currency filters, not the source misbehaving.

---

## 10. Where things live

| | |
|---|---|
| `packages/core/src/providers/pointsyeah.ts` | the whole provider — request, normalize, detail, coverage |
| `packages/core/src/providers/filter.ts` | `filterForParams` / `bookableCurrencies`, and the same-references contract |
| `packages/core/src/providers/window.ts` | `effectiveSearchWindow` / `chunkDateRange`, shared with every other source |
| `packages/core/src/sources/pointsyeah.ts` | the plug-in: `supports` / `plan` / `run`, `runtime: "local"`, `horizonDays: 70` |
| `packages/core/src/sources/index.ts` | where it is registered |
| `packages/local-sources/` | the runner that executes it — `npm run gather` |
| `packages/core/src/providers/__fixtures__/pointsyeah-explorer.json` | what the tests run against |

Invariants worth restating:

- **`pointsyeah` must never be renamed.** It is a stored value in
  `availability_snapshots.source` and `search_coverage.source`; a new name
  orphans every row it ever wrote, and nothing would prune them. It *was* renamed
  once, from `freetool:pointsyeah`, and that took a migration (`0009`).
- **Unmapped programs and cabins are dropped, never guessed** (FK protection).
- **Coverage is the clamped window, never the requested one.**
- **All chunks failing must throw**; some chunks failing must not.
- **`filterForParams` returns its input references** — the detail pass depends on
  it.

---

## See also

- `CLAUDE.md` — the invariants in short form.
- `docs/SOURCES.md` — the plug-in contract this implements, and the local runner.
- `docs/SEATS-AERO.md` — the other source, and why its program map is
  verified live.
