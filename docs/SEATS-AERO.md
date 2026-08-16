# seats.aero

The Partner API integration: `shared/src/providers/seatsaero.ts` (pure
wire handling plus the chunk loop), `api/src/search.ts` (Search),
`api/src/enrich.ts` (the itinerary behind a row), and the SPA controls
that drive both.

This is the only authenticated, metered source in the repo, and now **the only
source at all**: the aggregator that used to run from a residential connection
was removed, and with it the whole idea of a source running anywhere but this
Worker. See `docs/SOURCES.md` §1 for what may be added in its place.

---

## 1. Why this one is allowed on the Worker

The standing rule is that the Worker never calls an airline's own site. Carriers
worth having refuse datacenter IPs — United answers Akamai `428` and Delta `444`
to raw HTTP, and Delta denies a real browser session replayed verbatim, valid
`_abck` and all. And that is the *lesser* obstacle: the ones that let a browser
through gate award pricing behind a login anyway (`docs/HARVEST-POSTMORTEM.md`).

seats.aero is not an airline. It is a keyed vendor API that authenticates the
**credential, not the client**, and does not care that Cloudflare made the
request. The probe verdict, 2026-08-09, was "no anti-bot question here at all —
it wants the key, not a browser." That is the whole of the exception, and it is
evidence rather than convenience. If you are adding a `fetch` to an airline in
`api`, stop.

This used to say: *"nothing runs on a schedule. The endpoint fires because a
human pressed Search. A source the server can call is exactly what makes a cron
look tempting, and it is still forbidden."*

That sentence predicted this feature and it is no longer true. **Alerts**
(`docs/ALERTS.md`) is a Cron Trigger that re-searches routes marked for alerts
through this same integration. What made the prohibition right was that
unattended spending is unattended — so it was lifted with two things attached,
not on its own: a budget that reserves headroom for the human who presses
Search, and a rule that a sweep can never fail invisibly. `docs/ALERTS.md` §1 is
that argument in full; if you are re-litigating this, start there rather than
here.

The endpoint itself is unchanged, and still fires because a human pressed
Search.

### The meter

A Pro key buys **1000 calls per UTC day**, resetting at 00:00 UTC. Every response
carries the remaining count in `X-RateLimit-Remaining`. That number is a
**display, not a guard** — nothing in the codebase reads it to refuse a call, and
code that does is the deleted budget guard coming back (§9).

---

## 2. The endpoints

| endpoint | what it costs | what it buys | used |
|---|---|---|---|
| `GET /partnerapi/search` (Cached Search) | 1 call per page | a page of availability across ~20 programs, a whole date range, several airports | **yes — this is Search** |
| `GET /partnerapi/trips/{id}` (Get Trips) | 1 call **per availability row** | the real legs, including per-leg times | **yes — on a click** |
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
therefore load-bearing: it becomes `sourceFetchedAt`, and `findsCte` picks
winners by freshest `source_fetched_at`. Substituting the fetch time would let a
week-old cached row out-rank a fresher row from another source.

---

## 3. The economics, which are the design

```
tracked route window
   │ effectiveSearchWindow — clamp to [today, today+365]
   ▼
90-day chunks, at most 5 (SEATSAERO_CHUNK_DAYS, SEATSAERO_MAX_CHUNKS)
   │ one task per chunk
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

The page size is the one number that moved recently. Measured 2026-08-10: a
summary row is ~2.2 KB, the same row with its trips ~9.9 KB. At `take=1000` that
is a 10 MB response the Worker must hold as text and again as parsed objects, so
`take` dropped to 500 and `MAX_PAGES` rose to 10 — the same 5000-row ceiling per
chunk, at twice the calls. That trade is overwhelmingly worth it: the only other
way to learn the same routing is `/trips/{id}` at one call *per row*.

---

## 4. Search

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

Then, per chunk: `runSeatsAeroChunk` → build a `SourceTaskReport` → `recordTask`
→ `applyTask`. **The same ingest pipeline the alert sweep uses**, so both callers
fill one database under one set of coverage rules, and a search that dies halfway
has already stored what it found. A search is recorded as a `search_runs`
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
redacted in core** (`SEATSAERO_REDACTED`) before the record exists; never add it
back. Bodies are session-only — `search_tasks.capture_json` keeps the durable
half via `callMetadata`.

### Resuming, not capping

A Worker has a per-request subrequest budget. This used to be bounded
structurally (5 chunks × 5 pages = 25, full stop); with the smaller page a search
can reach 50 calls, which is no longer a number to leave to luck.

So the search became **resumable**. After `MAX_CALLS_PER_REQUEST` (25) the
endpoint stops *between* tasks — never mid-task, or a task's calls are spent for
nothing — and emits `run_continue` with the next index. The run row stays
`running` with `finished_at` NULL, and totals **accumulate** across requests
rather than overwriting.

`run_continue` is a **third terminal frame**, not an exception to the terminal
frame rule. `searchRoute` in `app/src/api.ts` hides it by re-issuing with
`?runId=&from=` until `run_done` or `error`, so consumers see one continuous
stream — but it still yields the frame so the UI can show the pause. The loop is
bounded at 64 requests so a Worker that somehow always pauses cannot spin.

Resuming reuses the **same run id**, because `search_coverage.run_id` is a
foreign key to it and a second row would split one search's coverage across two
runs.

If a platform limit is ever hit anyway, it degrades correctly rather than
corrupting: the chunk throws → `failed` → claims no coverage → the run is
`partial`.

---

## 5. Normalizing a response

`normalizeSeatsAero` is pure and is the whole of what the unit tests assert on.
One availability object fans out to up to **four** results — one per cabin with
space — because the snapshot row is keyed (route, date, program, cabin). There is
no `collapseBest` step: seats.aero has already collapsed the itineraries.

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

Unmapped `Source` values are **dropped** — `availability_snapshots.program` is a
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
  seats.aero carries no transfer data. An empty array is a correct answer
  (SkyMiles takes none of the couple's currencies) and the row still matters,
  because a cash fare from another source can make it reachable.
- **Never `cashPriceCents`.** seats.aero returns no revenue fare, and that field
  means the whole cash ticket.
- `stops: undefined` means **unknown** and stays that way for a summary row. It
  lands in the nullable `stop_count` column, whose NULL is exactly that.

---

## 6. `include_trips` — routing for free

Since 2026-08-10 a search asks for `include_trips=true`, so flight numbers,
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

## 7. Get Trips, and enrichment

`api/src/enrich.ts`. Two entry points: one find
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

- **Claims no coverage and prunes nothing.** `search_coverage` answers "did
  anyone look at (route, date, program)", and enrichment looks at a row that was
  already looked at. A coverage row here would move a find's freshness forward
  without re-checking whether the seat still exists.
- **Writes no `search_runs` / `search_tasks` row.** The observable-task
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

## 8. Coverage and truncation

A chunk claims coverage for the pairs it asked about and the dates it actually
saw. `SourceTaskReport.routes` carries the pair list; `origin`/`destination` stay
**real airports** (the first of each list), because `search_tasks` stores them as
NOT NULL scalars and `search_coverage`'s primary key would happily store an
"airport" called `SEA,PDX` that no future query could ever match.

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

## 9. Quota

`parseQuotaHeaders` reads `X-RateLimit-Remaining` (and `X-RateLimit-Limit` when
present) off **every** response, including failures — a 429 is exactly when it
matters. It returns `undefined`, never a fabricated number, when the header is
absent or unparseable: a missing observation shows as "not seen yet", which is
honest, where a guessed 1000 would read as "plenty left" on the one day you'd
want to know otherwise. The explicit null check exists because `Number(null)` is
0, which would turn a missing header into an exhausted quota that never happened.

`recordQuota` (shared with `enrich.ts` and the alert sweep) writes it to `source_quota`,
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

**Nothing INTERACTIVE reads it to refuse a call.** Search and enrich spend first
and report after, because nobody needs protecting from a call they deliberately
asked for — that was, and remains, the whole of the argument for deleting the
old budget guard.

There is now exactly one reader that consults it *before* spending:
`api/src/alerts/budget.ts`, the scheduled sweep. It spends with nobody
watching, which is the case a budget was always for, and it is in its own file so
that "who checks quota first" stays a one-file answer to `grep`. It extends the
`undefined`-not-1000 reasoning above rather than contradicting it: on a day
nothing has observed a number yet — most days — it neither refuses (the feature
would die silently) nor assumes a full allowance (optimistic in the direction
that overspends), but **self-accounts** from `SUM(search_runs.calls)` since
00:00 UTC, and lets the first real observation correct it. See `docs/ALERTS.md`
§7.

---

## 10. Failure modes

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

## 11. Probes

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

## 12. Where things live, and what must not change

| | |
|---|---|
| `shared/src/providers/seatsaero.ts` | everything above the Worker: pure `buildSearchUrl` / `normalizeSeatsAero` / `parseQuotaHeaders` / `parseSeatsAeroTrips`, plus `planSeatsAeroChunks` / `runSeatsAeroChunk` / `runSeatsAeroTrips` |
| `shared/src/routing.ts` | a route as a set of pairs; round-trip spec; the call estimate |
| `api/src/search.ts` | the Search endpoint, the stream, resumption |
| `api/src/enrich.ts` | Get Trips, one find and one route |
| `api/src/searchRun.ts` | the shared run/task/quota writers — `recordTask`, `recordQuota`, `MAX_STORED_CHANGES` |
| `api/src/quota.ts` | `GET /api/quota`, the chip's endpoint |
| `app/src/api.ts` | `searchRoute` / `enrichRoute` — hand-mirrored wire types, the resume loop |
| `app/src/useRouteSearch.ts`, `useRouteEnrich.ts` | the two stream hooks, owned by the **page** so a search survives navigating away |

Invariants worth restating, because each one silently corrupts data rather than
failing:

- **`SEATSAERO_SOURCE_ID` (`seatsaero`) must never be renamed.** It is a
  permanent database value: every row it ever wrote carries it and pruning is
  scoped by it. A new name orphans all of them, and nothing would ever prune rows
  that would sit there looking current forever. It *was* renamed once, from
  `api:seatsaero`, and that took a migration (`0009`, since folded into
  `0001_init.sql` — see `docs/HARVEST-POSTMORTEM.md` §7) touching four tables.
  The SPA then kept comparing against the OLD id for months: `quotaLeft` matched
  nothing, so the app-bar chip silently showed a raw string instead of a number.
  If you rename it, `PRIMARY_METERED_SOURCE` in `app/src/QuotaIndicator.tsx` is
  the hand-mirrored copy that has to move with it.
- **`UpdatedAt` → `sourceFetchedAt`.** Never the fetch time.
- **`raw_hash` is never touched by enrichment.**
- **The program map is verified live**, and unmapped sources are dropped.
- **Coverage is read off the payload, never off the plan.**
- **`minify_trips` is never enabled**, and `only_direct_flights`/`cabins` are
  never sent.
- **Quota is a display.** Anything that reads it before spending is the budget
  guard returning.

---

## See also

- `CLAUDE.md` — the invariants in short form.
- `docs/SOURCES.md` — the plug-in contract, and the ingest rules every source shares.
- `docs/HARVEST-POSTMORTEM.md` — why this is the only source the Worker calls,
  and why the ones that read carriers' own sites are gone.
