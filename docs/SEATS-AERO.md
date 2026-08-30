# seats.aero

The Partner API integration: `api/src/providers/seatsaero.ts` (pure
wire handling plus the chunk loop), `api/src/features/search/endpoints.ts` (Search),
`api/src/features/enrich/engine.ts` (the itinerary behind a row), and the SPA controls
that drive both.

---

### The meter

A Pro key buys **1000 calls per UTC day**, resetting at 00:00 UTC. Every response
carries the remaining count in `X-RateLimit-Remaining`. That number is a
**display, not a guard**: nothing in the interactive search/enrich paths reads
it to refuse a call — the one place that does read it before spending is
`api/src/features/alerts/budget.ts`, and nowhere else (§9).

---

## 1. The endpoints

| endpoint | what it costs | what it buys | used |
|---|---|---|---|
| `GET /partnerapi/search` (Cached Search) | 1 call per page | a page of availability across ~20 programs, a whole date range, several airports | **yes — this is Search** |
| `GET /partnerapi/trips/{id}` (Get Trips) | 1 call **per availability row** | the real legs, including per-leg times | **yes — on a click** |
| `GET /partnerapi/routes` (Get Routes) | 1 call **per source** | every city pair that program's inventory is monitored on | **yes — the Tools page's Data coverage tab** (§12) |
| `POST /partnerapi/live` | 1 call per (route, date, program), 5–15s | a real-time query against the airline | **no** |

Cached Search is by far the best value the API offers, which is why a year-long
window costs a handful of calls rather than a few hundred. `/live` is rejected on
its price: one call per (route, date, program) and 5–15 seconds each would spend
the day's whole allowance on a single route's single week, to refresh a cache
that is usually hours old at worst.

Get Trips is affordable exactly once the choice is a person's — one click, one
row, one call — so it is never part of a search. A 200-row chunk enriched
wholesale would spend a fifth of the day's allowance on decoration.

**Rows come out of seats.aero's cache, not off the airline.** `UpdatedAt` is
therefore load-bearing: it becomes `sourceFetchedAt` and is stored as
`finds.source_fetched_at` — when the DATA was current, never when we fetched it.
Substituting the fetch time would make every row look freshly observed on every
search, and there would be no way to tell a live quote from a week-old cached
one.

---

## 2. The economics, which are the design

```
tracked route window
   │ effectiveSearchWindow — clamp to [today, today+365]
   ▼
90-day chunks, at most 5 (SEATSAERO_CHUNK_DAYS, SEATSAERO_MAX_CHUNKS)
   │ one task per chunk PER QUERY — two queries on a route with hubs (§12)
   ▼
each chunk pages until hasMore is false, at most 10 (SEATSAERO_MAX_PAGES)
   │ take=500 with trips (SEATSAERO_TAKE_WITH_TRIPS)
   ▼
5 calls floor · 50 calls ceiling, for a whole year
```

- **The whole cross product is one call.** Cached Search takes comma-delimited
  airports on both sides (verified live 2026-08-10), so SEA/PDX → NRT/HND is one
  query, not four. Pairs are nearly free; only date chunks and pages cost.
- **Round trip is free in calls too.** `roundTripSpec` puts every airport on both
  sides of one call (`origin_airport=HND,SEA` with the same destinations,
  self-pairs dropped), so both directions ride back in the same response. It
  costs roughly twice the *rows*, which only makes a busy route paginate out
  sooner — and a truncated chunk narrows its own coverage claim honestly.
- **`MAX_ORIGINS` / `MAX_DESTINATIONS` are 3, and are not a spend limit.** Adding
  pairs costs almost nothing; the real cost of a wide route is **truncation**. A
  measured SFO→NRT 90-day window was already 851 rows for a single pair.
- `estimateSearchCalls` quotes the floor and ceiling in the route form, as a
  range, because the true number depends on how many rows the window holds —
  which is the thing a search finds out.

The page size is chosen for memory, not call count. Measured 2026-08-10: a
summary row is ~2.2 KB, the same row with its trips ~9.9 KB. At `take=1000` that
would be a 10 MB response the Worker must hold as text and again as parsed
objects, so `take` is 500 and `MAX_PAGES` is 10 — the same 5000-row ceiling per
chunk, at twice the calls. That trade is overwhelmingly worth it: the only other
way to learn the same routing is `/trips/{id}` at one call *per row*.

---

## 3. Search

`POST /api/tracked-routes/:id/search` → NDJSON.

### The request

`buildSearchUrl` is pure. What it sends, and what it pointedly does not:

| param | |
|---|---|
| `origin_airport`, `destination_airport` | comma-joined here so no caller invents a second convention |
| `start_date`, `end_date` | the chunk |
| `take` | 500 with trips, 1000 without (`seatsAeroTake`) |
| `sources` | exactly the programs we can store (§5) |
| `include_trips=true` | the routing, for no extra call (§6) |
| `cursor` | pagination |
| `order_by` | **deliberately left at its default** (departure date) |
| `minify_trips` | **never sent** — it drops exactly the routing fields |
| `only_direct_flights`, `cabins` | documented, real, **never sent** — gather wide, query narrow |

`order_by` is not cosmetic. Leaving it at departure date is what makes the
truncation rule sound: if pagination stops early, the dates lost are the *far*
ones, so the coverage claim can be narrowed to "everything through the last date
seen". Sorting by lowest mileage would scatter the missing dates through the
window and make any narrowing a guess. The probe confirmed this holds across
several pairs in one call — the response is ordered by date **globally**, with
pairs interleaved rather than emitted as per-pair blocks. Were it ever grouped by
pair, a single global `maxDate` would over-claim on the pairs the cursor never
reached and hard-delete their finds.

### The run

Everything fallible happens **before the stream opens**, because once the first
byte is written the response is committed to 200 and an `error` frame is all
that is left: the route lookup (404), the missing key (**503
`no_seats_aero_key`**, never an empty result), the chunk plan (400
`window_outside_horizon`), and the route spec (400 `bad_route_spec`).

Then, per chunk: `runSeatsAeroChunk` → build a `SourceTaskReport` → `applyTask`.
**The same ingest pipeline the alert sweep uses**, so both callers fill one
database under one set of coverage rules, and a search that dies halfway has
already stored what it found. A search is recorded as a `runs`
row like any other gathering run, distinguished only by `trigger = 'search'` —
which is also how the Alerts tab lists sweeps (`trigger = 'alert'`) without
listing hand-pressed searches.

One `makeTransport` for the whole search, and it is **sticky**: "the key was
refused" is a fact about the source, not about one chunk, so a 401 on the first
chunk costs one call rather than five.

### Frames

`run_start` · `chunk_start` · `call` · `chunk_done` · `quota` · **`run_continue`**
· `run_done` · `error`.

The `call` frame is the unusual one and it earns its place: *"3 API calls"* is a
number you can't act on. When a search comes back thinner than expected the
question is always which call, how long, and what did it actually say. Each call
streams the moment it lands, carrying timing, status, response headers and the
body — bounded by `CAPTURE_BUDGET_BYTES` (6 MB across the whole search), past
which calls still stream with `bodyOmitted` rather than vanishing. **The key is
redacted in the provider** (`SEATSAERO_REDACTED`, now `shared/src/wire/seatsaero.ts`) before the record exists; never add it
back.

**None of it is stored.** A call record is session state, streamed to whoever is
watching and lost on reload. There was a `search_tasks` table holding a row per
call — its status, timing, final URL and captured metadata — and nothing ever
read one back, while it cost four rows written per call. The place to look at a
call is the search that is making it.

### Resuming, not capping

A Worker has a per-request subrequest budget, and a full search can reach 50
calls (5 chunks × up to 10 pages each) — more than fits comfortably in one
request.

So the search is **resumable**. After `MAX_CALLS_PER_REQUEST` (25) the
endpoint stops *between* tasks — never mid-task, or a task's calls are spent for
nothing — and emits `run_continue` with the next index. The run row stays
`running` with `finished_at` NULL, and totals **accumulate** across requests
rather than overwriting.

`run_continue` is a **third terminal frame**, not an exception to the terminal
frame rule. `searchRoute` in `app/src/api/search.ts` hides it by re-issuing with
`?runId=&from=` until `run_done` or `error`, so consumers see one continuous
stream — but it still yields the frame so the UI can show the pause. The loop is
bounded at 64 requests so a Worker that somehow always pauses cannot spin.

Resuming reuses the **same run id**, because the run row is where a resumed pass
finds its place in the plan: `tasks_ok + tasks_failed` is the index to start
from, and the counters accumulate rather than being overwritten. A second run row
would restart the search from zero.

That makes task ORDER load-bearing across passes. `planSeatsAeroChunks` sorts its
airport lists so two plans of one route agree, and a plan that reordered between
passes would re-run some chunks and silently skip others.

If a platform limit is ever hit anyway, it degrades correctly rather than
corrupting: the chunk throws → `failed` → claims no coverage → the run is
`partial`.

---

## 4. Normalizing a response

`normalizeSeatsAero` is pure and is the whole of what the unit tests assert on.
One availability object fans out to up to **four** results — one per cabin with
space — because a `finds` row is keyed (route, date, program, cabin). There is no
further collapse step: seats.aero has already collapsed the itineraries.

### The program map is a live-verified list, and that is not ceremony

**An unrecognised `sources` value is silently ignored.** The API answers
`200 {"data":[]}` rather than erroring, so a misspelled program name is never a
bug you find — it is a program that quietly contributes nothing forever while the
task reports `ok`. Four plausible-looking guesses (`britishairways`, `ana`,
`cathay`, `eva`) failed exactly that way before being checked.

Every key in `SEATSAERO_PROGRAM_MAP` was verified live on 2026-08-09 against
`GET /partnerapi/routes?source=<name>`, and is pinned by a test. **A program's
name is not its source key**: `british` not `britishairways`, `copa` not
`connectmiles`. Qatar/British/Iberia all map onto one `avios` program code.

Unmapped `Source` values are **dropped** — `finds.program` is a
foreign key, so an unmapped source would fail the insert — and counted onto the
task's notes, so unmapped breadth shows up as a number rather than as silence.

### Field traps

- **`[C]MileageCost` is a string** on search rows and a **number** on trips.
- **`[C]TotalTaxes` is in cents.**
- **Each cabin field has a `*Raw` twin** including dynamically-priced results
  seats.aero filters out. `WAvailableRaw: true` beside `WAvailable: false` is
  normal — read the filtered fields.
- **`RemainingSeats: 0` means the program doesn't report seat counts** (American,
  Emirates), not "no seats" — `Available` already said there is at least one.
  Stored as 1, because a literal 0 would hide the row from every `minSeats`
  filter.
- **`{L}Airlines` is every carrier on any itinerary in this cabin;
  `{L}DirectAirlines` is the subset flying it nonstop.** The captured SFO→NRT row
  reads `YAirlines: "AS, CX, JL, JX, PR"` beside `YDirectAirlines: "JL"`, so
  taking `airlines[0]` for a nonstop would name AS — the one carrier that
  specifically does not fly it nonstop. Both are stored, along with
  `{L}DirectMileageCost` when a nonstop exists and costs more than the quoted
  award.
- **`{L}Direct` is about the cabin, not about the quoted award.** They differ
  whenever the direct price is dearer, which is common.
- **Route endpoints come off the payload's own `Route`, never off the request.** A
  multi-airport query answers with rows for whichever airports it has, and ingest
  keys coverage and pruning on the route it is told.
- **`bookableWith` comes from our own transfer table**, not the payload —
  seats.aero carries no transfer data. An empty array is a correct answer for a
  program nothing transfers to, and the row is still stored and still counted;
  it just cannot surface under a currency-filtered route.
- `stops: undefined` means **unknown** and stays that way for a summary row. It
  lands in the nullable `stop_count` column, whose NULL is exactly that.

---

## 5. `include_trips` — routing for free

A search asks for `include_trips=true`, so flight numbers,
connection airports, aircraft, fare classes and total duration arrive **with the
search, for no extra metered call**. All 12 sources in the measured response
presented populated trips.

**A search-embedded trip has no `AvailabilitySegments`.** The same `SeatsAeroTrip`
type covers both shapes, and `tripSegments` reads whichever is present:

| | `/search?include_trips` | `/trips/{id}` |
|---|---|---|
| legs | `OriginAirport` + `Connections` + `DestinationAirport` | `AvailabilitySegments[]` |
| flights | `FlightNumbers` (`"AS471, AS123"`) | per segment |
| times | trip-level `DepartsAt`/`ArrivesAt` only | **per leg** |

So the search form knows *which aeroplanes and via where*; the trips form
additionally knows *when each leg goes*. `chainSegments` rebuilds the legs from
the first form, under three rules:

- **Airports and flights must agree** — `n` airports means `n − 1` flights. When
  they disagree the trip is **dropped, not guessed**: a guessed leg names an
  aeroplane that is not on the ticket and nothing downstream could tell.
- **`Carriers` is the DISTINCT set, not one per leg.** Two Alaska legs give
  `"AS"`. The per-leg carrier comes off the flight number prefix instead.
- **`Aircraft` and `FareClasses` are genuinely optional** — absent on different
  programs in the same response — so they attach per leg only when present at the
  right length, and their absence never drops a trip.

Per-leg times do not exist in this form, so the trip's own `DepartsAt`/`ArrivesAt`
are placed on the first and last leg **and nowhere else**. A middle leg with no
times is the truth; inventing them from `TotalDuration` would render a layover
that was never measured.

Each chunk records on its notes how many rows actually came back described,
rather than asserting either state.

---

## 6. Get Trips, and enrichment

`api/src/features/enrich/engine.ts`. Two entry points: one find
(`POST /api/finds/enrich`) and a whole route
(`POST /api/tracked-routes/:id/enrich`, NDJSON, same stream contract as search).

**One id covers all four cabins** of a (route, date, program), so the unit of work
is the availability row, not the find, and one call expands up to four rows. That
is the entire economics of the feature — and the reason the single-find endpoint
takes no cabin: charging for economy and leaving business a summary would waste
the more expensive half of the response.

### The price filter is load-bearing

**The trips under one id are NOT all the same award.** One captured SFO→NRT row
held economy itineraries at 37,500 / 40,000 / 75,000 miles, and the summary quotes
only the cheapest. Without the filter, collapsing picks the *fastest* trip — a
925-minute routing at 40,000 — and writes it onto a find claiming 37,500. The row
would then describe an aeroplane you cannot have at that price.

So only trips priced **exactly** like the stored row are candidates, and a cabin
with no match is left alone. A miss stays a miss. `collapseTripsByCabin` is shared
by both paths — `/trips/{id}` and the search-embedded trips — because two
implementations of "which real aeroplane does this find describe" would eventually
disagree about the same row.

`parseSeatsAeroTrips` **throws** rather than returning empty when the payload is
about a different availability id. A wrong-row payload is the one failure that
decorates a find with someone else's flights and is indistinguishable from success
afterwards — the same reason Delta's `parse` rejects foreign dates.

### Four things the live capture settled

Captured 2026-08-10 (`npm run probe:seatsaero-trips`); the fixture beside the
source is that capture, untrimmed. Each of these would have been a plausible wrong
guess:

1. A trip's `MileageCost` is a **number**, unlike Cached Search's string.
2. `Cabin` is a **full word** ("economy", "business"), not the Y/W/J/F letter.
3. The trips are **not all the same award** (above).
4. **`DepartsAt`/`ArrivesAt` are local times wearing a `Z`.** `AS515` SEA→NRT
   reads `11:50:00Z` → `15:05:00Z` next day — 27h elapsed against a stated
   `Duration` of 615 minutes. The suffix is a lie; `localTime` strips it, because
   storing it would claim UTC for a wall-clock time and the first consumer to do
   date maths would move every flight by the airport's offset.

`Order` on a segment is authoritative — do not trust array order. An unrecognised
cabin is **dropped, never guessed**.

### Enrichment is additive

It rewrites `segments_json` / `stop_count` / `duration_minutes` / `booking_url` /
`is_direct` and sets `detail_level` / `enriched_at`. It **never touches
`raw_hash`**, and that is the single most important line in the module:
`hashResult` folds segments in, so `raw_hash` must keep describing what
seats.aero *said*, which is what the next search compares against. Rewrite it and
every search would see a changed row, insert a fresh summary on top, and throw
the enrichment away — forever. Pinned by the `applyTask — write-on-change` tests.

Three things enrichment deliberately does **not** do:

- **Claims no coverage and prunes nothing.** A coverage claim says "I looked at
  this slice and what I return is the complete truth for it", and enrichment
  looks at ONE row that was already looked at. Claiming here would license
  deleting every other row in that slice on the strength of a detail fetch that
  never asked about them.
- **Writes no `runs` row.** The observable-task
  invariant is about unattended gathering, where a failure is otherwise
  indistinguishable from "no award space". A failure here goes straight back to
  the person who clicked, as a status code. What stays durable is `enriched_at` —
  the record that a call was spent.
- **Never consults the quota before spending.**

`enriched_at` is stamped **even when nothing came back at the stored price**. The
difference between "not tried" and "tried, seats.aero had no itinerary" is the
difference between an inviting button and one that says so — the finds table
renders four distinct states off this, and without the stamp it would offer the
same wasted call forever. The per-row button still allows a deliberate retry.

### The route sweep

`ENRICH_MAX_PER_RUN` is 25 — both a Worker subrequest budget and a spend ceiling.
Unlike search there is **no `run_continue`**: the cap ends the sweep rather than
pausing it, and `run_done` carries `capped` and `remaining` so the UI can say
"25 of 63" rather than implying it is done. Targets are ordered by date so a
capped run enriches the near dates first.

Two kinds of row are worth a call, and the second only exists since
`include_trips`:

1. a `summary` — no itinerary at all;
2. an `itinerary` **missing its per-leg times** — a chain-rebuilt trip that knows
   which aeroplanes and via where, but not when it lands between them. Detected as
   "leg two exists and has no `departsAt`". A nonstop is fully timed already and
   is never a target.

`enriched_at IS NULL` is what stops a sweep re-buying a known miss out of the same
1000.

---

## 7. Coverage and truncation

A chunk claims coverage for the pairs it asked about and the dates it actually
saw. `SourceTaskReport.routes` carries the pair list; `origin`/`destination` stay
**real airports** (the first of each list), because `runs` stores them as NOT
NULL scalars and the baseline read's pair filter would happily take an "airport"
called `SEA,PDX` and match no stored row at all.

- **The empty pairs are claimed too, and must be.** "seats.aero answered a query
  covering PDX→HND and returned nothing" is a real `empty`; without the claim, a
  find that genuinely vanished there could never be pruned.
- **The status gate is upstream of the pair fan-out.** A blocked call covering
  four pairs looked at none of them, and `routes` is carried on the failure path
  too — `status` is checked first, so it costs nothing and keeps one shape.
- **A truncated read narrows its own claim.** Paginating out at `MAX_PAGES` sets
  `coveredDates` to the dates through `maxDate` and says so in the chunk's notes
  and in the `chunk_done` frame's `note`. Claiming the whole chunk anyway would
  let a later prune delete real finds on dates nobody saw.

Only a run that claimed coverage may say the route was checked: a wholly-failed
search leaves `tracked_routes.last_checked_at` alone, so the route keeps reading
as never searched — which is the truth.

---

## 8. Quota

`parseQuotaHeaders` reads `X-RateLimit-Remaining` (and `X-RateLimit-Limit` when
present) off **every** response, including failures — a 429 is exactly when it
matters. It returns `undefined`, never a fabricated number, when the header is
absent or unparseable: a missing observation shows as "not seen yet", which is
honest, where a guessed 1000 would read as "plenty left" on the one day you'd
want to know otherwise. The explicit null check exists because `Number(null)` is
0, which would turn a missing header into an exhausted quota that never happened.

`recordQuota` (`api/src/db/runs.ts`, shared with enrich and the alert sweep) writes it to `source_quota`,
keyed by source and **UTC day** derived from `observedAt` — because that is when
the allowance resets. The upsert's `WHERE excluded.observed_at >=
source_quota.observed_at` is what stops a late older observation rolling
`remaining` back up to a number that has since been spent.

`GET /api/quota` returns the last week plus the server's own `today`, so
the SPA doesn't have to agree about what UTC day it is. `QuotaIndicator` renders
it as an `n/1000` chip in the app bar; `QuotaSplash` shows the same number
full-screen once on unlock. Both read one `summarizeQuota`, so they cannot quote
different numbers off the same payload, and both repeat that it is a display, not
a limit.

**Only the bolt chip is seats.aero's.** That cluster now carries three meters —
the two arrows beside it are D1's daily rows read and written, off a separate
payload (`GET /api/d1-usage`) and a separate poll. They share the tone scale and
the 00:00 UTC reset and nothing else; `docs/SOURCES.md` does not cover them,
because D1 is not a source. `QuotaSplash` is still seats.aero alone.

**Nothing INTERACTIVE reads it to refuse a call.** Search and enrich spend first
and report after, because nobody needs protecting from a call they deliberately
asked for — that was, and remains, the whole of the argument for deleting the
old budget guard.

There is now exactly one reader that consults it *before* spending:
`api/src/features/alerts/budget.ts`, the scheduled sweep. It spends with nobody
watching, which is the case a budget was always for, and it is in its own file so
that "who checks quota first" stays a one-file answer to `grep`. It extends the
`undefined`-not-1000 reasoning above rather than contradicting it: on a day
nothing has observed a number yet — most days — it neither refuses (the feature
would die silently) nor assumes a full allowance (optimistic in the direction
that overspends), but **self-accounts** from `SUM(runs.calls)` since
00:00 UTC, and lets the first real observation correct it. See `docs/ALERTS.md`
§7.

---

## 9. Failure modes

`makeTransport` turns 401/403/429/451/503, Akamai 428, edge-deny 444 and
challenge-shaped bodies into `BlockedError` before they can reach a parser as
data. `classifyError` — shared by search, enrich and the sweep so the three
cannot disagree about what `blocked` means — sorts throws into `blocked` /
`challenged` / `timeout` / `failed`.

**Throwing is the failure protocol** here as everywhere: never catch inside
`runSeatsAeroChunk` and return an empty result, because `offers: []` with a
coverage claim means "I looked and there is nothing", which licenses a prune.

| symptom | what it is |
|---|---|
| 503 `no_seats_aero_key` before the stream | `SEATS_AERO_API_KEY` unset. Never an empty result |
| `blocked` at 401 | wrong key |
| `blocked` at 429 | the day's allowance is gone |
| `blocked` with status 0 | the **sticky** transport: something already refused us, so nothing was asked |
| a program contributing nothing, task `ok` | almost certainly a source key that isn't real — the API ignores unknown ones silently |
| `dropped N rows from unmapped programs` in the notes | breadth we could store and don't; a mapping decision, not a bug |
| chunk `note` mentioning narrowed coverage | paginated out. The far end of that window was not looked at |
| run `partial` | at least one chunk never got an answer |

A failed call is recorded with whatever came back — a 500's body is often the only
explanation you get.

---

## 10. Probes

Both spend real calls and print what is left, read off the same header
`parseQuotaHeaders` reads.

```sh
npm run probe:seatsaero-search -- --from SFO --to NRT --days 120
npm run probe:seatsaero-search -- --from SFO,OAK --to NRT,HND --days 120
npm run probe:seatsaero-trips -- --from SFO --to NRT --days 120   # 2 calls
npm run probe:seatsaero-trips -- --id <ksuid>                     # 1 call
```

The search probe exists because the parameters that changed this architecture —
`include_trips` and comma-delimited airports — are documented in shape but not in
**cost**. The Worker holds a page in memory and streams a bounded capture of it,
so the probe measures bytes, not just shape. It reports and compares; it does not
guess.

The trips probe exists because `/trips` had no live backstop: its parser decides
which real aeroplane a stored find describes, so writing it against a guessed
payload is exactly the mistake the ledger exists to prevent.

Fixtures are committed forever: the key is redacted, long arrays trimmed. Read the
file before committing it.

---

## 11. Where things live, and what must not change

| | |
|---|---|
| `api/src/providers/seatsaero.ts` | everything above the Worker: pure `buildSearchUrl` / `normalizeSeatsAero` / `parseQuotaHeaders` / `parseSeatsAeroTrips`, plus `planSeatsAeroChunks` / `runSeatsAeroChunk` / `runSeatsAeroTrips` |
| `api/src/domain/routing.ts` | a route as a set of pairs; round-trip spec; the call estimate |
| `api/src/features/search/endpoints.ts` | the Search endpoint, the stream, resumption |
| `api/src/features/enrich/engine.ts` | Get Trips, the engine; `api/src/features/enrich/endpoints.ts` the two HTTP shapes |
| `api/src/db/runs.ts` | the run and quota writers — `recordQuota`, `finishRun`, `MAX_STORED_CHANGES` |
| `api/src/features/search/run.ts` | the engine: `planSearchPass` / `openSearchRun` / `runSearchPass` |
| `api/src/features/usage/quotaEndpoints.ts` | `GET /api/quota`, the chip's endpoint |
| `app/src/api/search.ts`, `enrich.ts` | `searchRoute` / `enrichRoute` and the resume loop. The wire types they speak are `shared/src/wire/`, not copies |
| `app/src/pages/routes/useRouteSearch.ts`, `useRouteEnrich.ts` | the two stream hooks, owned by the **page** so a search survives navigating away |

Invariants worth restating, because each one silently corrupts data rather than
failing:

- **`SEATSAERO_SOURCE_ID` (`seatsaero`) is still a stored value, but only in one
  place: `source_quota.source`.** `finds` carries no provenance column, so
  renaming the id no longer orphans award rows — it orphans today's quota
  reading, which self-corrects on the next call. `app/src/lib/quota.ts`'s
  `PRIMARY_METERED_SOURCE` still derives from it through
  `shared/src/wire/seatsaero.ts` rather than repeating the literal, so the SPA's
  quota chip cannot drift out of sync with the value the Worker writes.
- **`UpdatedAt` → `sourceFetchedAt`.** Never the fetch time.
- **`raw_hash` is never touched by enrichment.**
- **The program map is verified live**, and unmapped sources are dropped.
- **Coverage is read off the payload, never off the plan.**
- **`minify_trips` is never enabled**, and `only_direct_flights`/`cabins` are
  never sent.
- **Quota is a display.** Anything that reads it before spending is the budget
  guard returning.

---

## 12. The route graph

`GET /partnerapi/routes?source=<name>` returns every city pair a program's award
inventory is monitored on. It backs the Tools page's **Data coverage** tab, and it is
appended as §12 rather than inserted so the section numbers `CLAUDE.md` and
`docs/ALERTS.md` cite do not move.

### What it actually returns

A **bare array** — not a `{data}` envelope — of objects with seven fields:
`ID`, `OriginAirport`, `OriginRegion`, `DestinationAirport`, `DestinationRegion`,
`Distance`, `Source`. Measured live on 2026-08-18: `alaska` 8,130 rows / 1.43 MB,
`aeroplan` 8,338 rows / 1.46 MB, ~180 bytes a row. Both fixtures are committed
under `api/src/providers/__fixtures__/`, each carrying a `measured` block that
describes the WHOLE payload, because the committed body is trimmed to 25 rows.

Three measured facts the schema depends on, none of them guessable:

- **Pairs are unique within a source** (8,130/8,130 and 8,338/8,338 distinct), so
  `seatsaero_routes` can key on `(source, origin, destination)`.
- **`Distance` is an integer**, so the column is `INTEGER`. The unit is
  **statute miles**, and that is INFERRED, not documented: the API reference's
  own example gives TPE–PNH as 1423, and that pair's great circle is 2290 km =
  1423 mi.
- **`NumDaysOut` does not exist.** The published example at
  `developers.seats.aero/reference/get-routes-1` shows `NumDaysOut: 60`, and zero
  of those 16,468 rows carried it — `aeroplan` included, which is the very source
  that example is written from. A per-route monitoring horizon is the obvious
  thing to want here and the data is simply not there.
  `seatsaero-routes.test.ts` pins its absence so a future reader does not go
  looking twice.

### `200 []` is an answer, not a failure

**seats.aero returns HTTP 200 with an empty array for a source name it does not
recognise.** No error, no 404. That is the same trap §4 records: `britishairways`,
`ana`, `cathay` and `eva` all look right and all return nothing.

So the fetch itself is written down, in `seatsaero_route_fetches`, one row per
source, with a status of `ok` / `empty` / `failed`. Without that row, "no routes
for X" means either *we never asked* or *that name is wrong*, and nothing
downstream can tell which. **`empty` is a success and must never render as an
error** — it is the most informative thing this surface reports.

Verified live: fetching `britishairways` records `status: "empty"`,
`http_status: 200`, `bytes: 2`.

### The write

One metered call, then a delete-and-replace inside a **single `db.batch()`** —
one implicit transaction, so a source is never observed half-replaced and a
failure leaves the previous graph standing. The payload is the program's whole
network, so a merge would leave pairs it has stopped flying standing forever.

Rows are inserted through **`json_each`**, binding a chunk of 500 as one JSON
parameter. That is not cleverness, it is arithmetic: **D1 allows 100 bound
parameters per query** (not SQLite's 999) and **1,000 queries per Worker
invocation**, with batch statements counting toward the second. Eight columns
would fit twelve rows per `INSERT … VALUES`, so a measured graph would be ~700
statements; `json_each` makes it 17, at two binds each. Measured end to end at
**343 ms for 8,130 rows**, of which 186 ms was seats.aero.

`recordQuota` is called with no run row, exactly as enrichment does (§8) — this
is interactive work, and it reports its own failure to whoever triggered it.

### The pane

`/api/seatsaero/*` (`api/src/features/graph/endpoints.ts`). **Exactly one path
spends anything**: `POST /api/seatsaero/sources/:source/fetch`. It is in
`METERED_PATTERNS` in `e2e/fixtures.ts`, so a UI test that reaches it fails
loudly instead of quietly spending. Everything else is a D1 read — which is the
whole reason the graph is cached rather than proxied: browsing 26 programs live
would be 26 calls every time the tab was opened.

**Two things reach that path, and one of them is a selection.** Picking a program
nobody has ever fetched fetches it, because the alternative is a pane that
answers every question with "nothing is known yet" until a second button is
pressed. It neither names its cost nor asks first — this app spends first and
reports after everywhere else, and `alerts/budget.ts` stays the only reader that
checks a budget before spending. Three guards in `SourceBar.tsx` are what keep
that from being a call spent by accident, and all three are load-bearing:

- It fires on an explicit **selection, never on mount.** Opening the tab must
  cost nothing — the UI harness visits `/tools/coverage` on every run, and
  `e2e/tools.spec.ts` leans on exactly this. It is also why no spec there may
  pick a source.
- Only a source with **no fetch record at all.** A `failed` one has been asked
  already; retrying is what Refresh is for, and auto-retrying would spend a call
  every time someone flipped back to it.
- **Once per source per session** (`autoFetched`), so a fetch that errors before
  it can record anything cannot become a loop.

The pane tells "never fetched" from "being fetched right now" with
`useIsMutating` on the mutation's key rather than by lifting the mutation out of
the component that owns the button.

**The map draws a vector basemap, and reaches no tile server.** It is the same
`data/worldGeometry.ts` the trip list's `RouteMap` draws, through
`basemapRings()` in `lib/routeMapGeometry.ts`, in the same green land over blue
water — which is the point: a raster tile is a PNG and nothing downstream can
recolour it, so a map that wants its own cartography cannot have tiles. The
sibling `AirportMap` still does, and `*.basemaps.cartocdn.com` is in the CSP for
that one alone. Three consequences worth knowing:

- Leaflet repeats tiles across copies of the world for free and repeats vectors
  not at all, so the geometry is handed over again at **±360°** or the world ends
  in open water at the antimeridian.
- All the rings of a layer go into **one** `Polygon`, with
  `fillRule: "nonzero"` (they are separate landmasses, not a shape with holes,
  and Natural Earth does not promise a consistent winding) and
  `interactive: false` (or Leaflet hit-tests every vertex on every mouse move).
- Everything painted over the basemap is a **fixed** colour, arcs included. The
  ground is no longer the theme's, so a theme whose accent is a deep blue would
  sink into the ocean.

The table and the map share one `routeFilter` WHERE builder, the way
`/api/airports` and `/api/airports/geo` share `airportFilter`. Unlike that one,
`source` is **required** — a route graph is per program by nature, and the
cross-source question has its own surface.

**A three-letter free-text token is matched as a CODE and nothing else.**
Substring-matching one against airport names is close to useless: `PIT` appears
in "Aspen-**Pit**kin County", "Beijing Ca**pit**al" and "Cherry Ca**pit**al", so
asking for Pittsburgh returned Aspen, Beijing and Traverse City. Anything longer
keeps the name/city search. This is the common case rather than the edge one —
the `defaultAirport` preference (`app/src/lib/preferences.ts`, seeded into this
filter) produces exactly such a token. Pinned by `seatsaeroRoutes.test.ts`.

The list sits **beside** the map from `md` up and takes only the width its
columns need (`width: max-content`, `flex: 0 0 auto`); a `minWidth: 100%`
alongside that would silently defeat it and spread the columns back out. None of these is gated on
`isLocalRequest`: the Airports pane is dev-only and this one ships, which is also
why the map gets its coordinates from this endpoint's own join to `airports`
rather than calling `/api/airports/geo`, which would 404 in production.

### Reach, which is NOT coverage

`assessGraphReach` (`api/src/features/graph/reach.ts`) asks whether the pairs a
tracked route covers are in anybody's graph. **Do not call this coverage.**
Coverage means *did WE look at (route, date, program)* — a fact about our own
searching that licenses a prune. This is a fact about the SOURCE'S network, true
before anyone searches anything, and it can never license a prune.

It expands routes with `searchPairs`, the same function the search plans with, so
the panel cannot report on a pair the search never asks about. A route's verdict
is its **worst pair's**: SEA/PDX→NRT/HND is four independent pairs, and one of
them in nobody's graph is a named hole rather than a route that is mostly fine.
`unknown` is a real verdict — with nothing fetched there is nothing to conclude,
and a `failed` source is excluded from the fetched set because an incomplete
graph must never be evidence of absence.

### Connections, and what a path is NOT

Read as a set of isolated edges, the graph says SFO→KTM is impossible. It is not:
nine hubs join it, the best at a 7% detour. Every long-haul without a nonstop
market — which is most of the interesting ones — read as a flat `gap` until
`features/graph/paths.ts` existed.

**A path is not an itinerary, and the pane owes the reader that sentence.** It is
a claim about which markets seats.aero *monitors*, chained. The distinction is
operational, not pedantic: seats.aero holds availability **per monitored
market**, so searching SFO→KTM returns nothing however many hubs join it. The
legs are the searchable objects. That is why a path is reported as its legs, and
why the only action offered is **Track these legs**, which creates one tracked
route per leg through the ordinary `POST /api/tracked-routes` and hands them to
the normal Search/Alerts loop.

Note what this does *not* change: a pair that **is** in the graph already returns
connecting itineraries, because a market's availability carries them —
`__fixtures__/seatsaero-search-trips.json` has SFO→NRT arriving as
`Stops: 1, Connections: ["SEA"]`. The hole was only ever the unmonitored pair.

**The ladder stops at the first depth that answers**: direct, then one stop, then
two. JFK→LHR is a monitored market and never runs a self-join; SFO→KTM answers at
one stop; PIT→KTM has no one-stop option and needs two. Going deeper than the
shallowest answer buries the good routing under hundreds of worse ones — JFK→LHR
at two stops is 6,092 rows.

**Two stops is one program's own network or nothing.** One stop collects both
tiers from a single unrestricted join and `rankPaths` sorts them: paths one
program covers end to end first (plausibly one award), then paths needing a
different program per leg — real, but one award per leg, two currencies, and the
connection at the traveller's own risk, so they are labelled *needs two awards*
rather than ranked among the others. Three legs in three programs is three award
tickets, and unrestricted it measured **240 ms and 14,485 rows over 625 hub
pairs** on a busy pair, so the mixed tier ends at one stop. Programs are
intersected rather than sources, so a Qatar leg and a British Airways leg are one
Avios path rather than two.

The detour budget is `max(great_circle × ratio, great_circle + 800 mi)`, with the
ratio 1.5 at one stop and 1.7 at two. Both halves are load-bearing and both are
measured. SFO→KTM's real options run to a **1.40** ratio (SIN, on Singapore
Airlines), so a 1.4 cap would have cut the last true answer. And PDX→GEG is
280 miles with an ordinary connection through Boise at 630 — a ratio of 2.25 —
so a ratio-only budget rejects every short-haul connection there is.

**`distance_mi` bounds the SQL; haversine decides.** The self-join pre-filters on
the stored distance because it is free to, but 350 of 41,780 measured rows carry
a zero and the migration is explicit that zero means nothing useful. A zero leg
only ever lets too much *through*, which `rankPaths` then judges from
coordinates. Every distance the UI shows is computed, never stored.

**No new index, and no migration.** `idx_sa_routes_pair` leads on `origin` for
the forward expansion and `idx_sa_routes_dest` on `destination` for the backward
one, which is exactly what a self-join needs. Measured on the live local graph
(41,780 rows, 9 fetched sources): **3 ms** at one stop, **~20 ms** at two.

`assessGraphReach` runs **twice** in the reach endpoint, and that is deliberate:
the first pass is what says which pairs are gaps, and only the function that owns
the gap rule should decide. Re-deriving gap-ness in the endpoint would be a
second copy of that rule. Only the gaps are then searched — one bulk query at one
stop, and one at two capped at `REACH_DEEP_PAIRS` (12) pairs. A pair that cap
skipped carries `deepCheckSkipped` and says so on screen, because "we stopped
looking" is not "there is nothing there".

The verdict that comes out is **`indirect`**, ranked between `gap` and `ok`
because it genuinely is between them: the network reaches the pair, and the route
as written still returns nothing. Calling it `ok` would hide work the user has to
do.

### A route that carries its own hubs

A tracked route may store `via` hubs, and it then plans **two queries per date
chunk** rather than one:

```
outbound   SFO -> ICN,DEL,HKG,KTM      origins × (destinations ∪ hubs)
inbound    ICN,DEL,HKG -> KTM          hubs × destinations
```

It cannot be one query. The whole cross product rides in a single call (§2), but
`SFO->ICN` and `ICN->KTM` are different markets, and no single pair of airport
lists names both without also naming hub-to-hub pairs nobody asked for. So the
one thing §2's economics did not cover is the one thing hubs change: a year-long
route goes from **5 calls to 10**, and `plan.tasks` becomes `chunks × groups`,
**chunk-major**. Per-TASK cost is untouched, which is why
`MAX_CALLS_PER_REQUEST`, the cron's 30-second CPU rule and `run_continue` all
keep working unchanged — and why everything that budgets calls had to start
counting tasks instead of chunks (`docs/ALERTS.md` §4).

The outbound query carries the DIRECT pair deliberately: the hubs simply join its
destination list, so the pair the route is named for is still asked every search
at no extra call, and the day a program starts flying it the route notices.

Hubs are capped at **three** (`MAX_VIA`), and the cap is about ROWS rather than
quota — a fourth costs no calls but pushes the outbound query past what
`SEATSAERO_MAX_PAGES` covers on a busy pair, at which point the chunk narrows its
own coverage claim (§7) and the calls dialog marks it `partial`. Measured on a
live database: one busy market over a year already spent 32 calls across five
ranges, about 6 of the 10 allowed pages. The headroom is real but not generous.

Hubs are filled in automatically by `autoVia` when a route is saved and its pair
reaches nothing directly, using the same `searchGraphPaths` this section
describes — which moved to `api/src/features/graph/pathSearch.ts` when it gained a third
caller. `via` is ignored on a round trip, silently: four query groups and a
pairing of pairings is a different feature, and a route flipped to round trip
long after its hubs were filled must not become unsearchable.

**What happens after the legs are stored is not in this file.** Once a route has searched its hubs, the legs are ordinary finds, and joining them back into an
SFO→KTM answer is a read over stored rows with no seats.aero in it at all —
`app/src/lib/multiLeg.ts`, rendered by `pages/routes/MultiLegTable.tsx`. It
belongs to the finds pipeline rather than to this integration, and the one thing
worth carrying across the boundary is the vocabulary: a path here is a claim
about monitored markets, a *journey* there is a claim about stored availability,
and neither is a claim that anybody will sell you the whole thing as one ticket.

---

## See also

- `CLAUDE.md` — the invariants in short form.
- `docs/SOURCES.md` — the plug-in contract, and the ingest rules every source shares.
- `CLAUDE.md` — the host rule, and why this is the only data source the Worker
  is allowed to call.
