# Alerts — the one scheduled thing

A Cron Trigger wakes every fifteen minutes, re-searches the tracked routes marked
for alerts, and emails a digest when something has changed. It is the **only
unattended work in this codebase**, and everything below exists because
unattended work is a different kind of thing from a button somebody pressed.

It is not, however, a second engine. A sweep is the *same* Search — the same
`planSearchPass` / `openSearchRun` / `runSearchPass` in `api/src/search/run.ts`,
the same `applyTask` ingest, the same coverage rules, the same `search_runs` row.
`search/run.ts` has **two callers and one behaviour**; the only difference is
whether an `onEvent` callback is passed, i.e. whether anyone is listening.

```
                        ┌──────────────────────────────────────────┐
  cron */15  ─────────▶ │ runAlertTick        (alerts/sweep.ts)    │
                        │   1. read alert routes + their clocks    │
                        │   2. sweepPacing   → how often (pace.ts) │
                        │   3. dueRoutes     → who, most overdue   │
                        │   4. per route, while calls remain:      │
                        │        decideSweep → can it be paid for  │
                        │        sweepRoute  → search/run.ts       │
                        │        selectAlertable → alert_outbox    │
                        │   5. cycle complete? → flushOutbox       │
                        └──────────────────────────────────────────┘
                                        │                    │
                             ingest (applyTask)      Resend → digest
                                        │                    │
                          availability_snapshots     alert_deliveries
```

Where things live:

| file | what |
|---|---|
| `api/src/alerts/sweep.ts` | the tick, the sweep, the outbox, the flush |
| `api/src/alerts/budget.ts` | **the only budget guard in the repo** |
| `api/src/endpoints/alerts.ts` | the four `/api/alerts/*` endpoints |
| `api/src/alerts/email.ts` | Resend, and the read of the recipient allowlist |
| `api/src/endpoints/settings.ts` | editing that allowlist — `alert_recipients` |
| `api/src/alerts/pace.ts` | cost, cadence, due-ness, back-off, baseline — all pure |
| `api/src/alerts/select.ts` | which changes are worth an email — pure |
| `api/src/alerts/digest.ts` | grouping and rendering — pure |
| `app/src/pages/alerts/AlertsPage.tsx`, `app/src/lib/alerts.ts` | the safety surface |
| `api/wrangler.toml` `[triggers]` | `crons = ["*/15 * * * *"]` |
| `migrations/0001_init.sql` | `alert_*` columns, `alert_outbox`, `alert_deliveries` |
| `migrations/0008_alert_recipients.sql` | `alert_recipients`, the allowlist |

---

## 1. Why there is a cron at all

Unattended work is a risk this codebase takes seriously, for two reasons that
shape everything below: it can hide a source failure behind an empty result,
and a process spending API calls with nobody watching needs a budget a person
pressing a button does not. Both are addressed directly rather than by avoiding
a cron altogether.

### Unattended work hides source failures

This is the failure this whole application is built against: **a source that
quietly returns nothing is indistinguishable from "there is no award space on
this route."** A person pressing Search watches a stream and sees a red frame.
Nobody watches a cron.

The answer is not "be careful". It is that **a sweep is an ordinary `search_runs`
row** — `trigger = 'alert'`, with its tasks, its `calls`, its `error`, its
status — plus three per-route counters (`alert_last_attempt_at`,
`alert_last_digest_at`, `alert_consecutive_failures`), and a surface built to
read them: the Alerts tab, plus a dot on the tab strip
(`AlertsHealthDot` in `app/src/router.tsx`) so you find out without opening a tab
you have no reason to open. A sweep that has been failing all day reads as *a
failing sweep*, not as an absence of award space.

That is load-bearing because of the second rule, below.

### **No email is ever sent about a failure**

Only finds produce mail. A blocked, refused, budget-skipped or exception-thrown
sweep sends nothing, on purpose — a scheduler that mails you about itself trains
you to ignore its mail.

The consequence constrains code far outside `alerts/`:

> **Unattended work must never fail invisibly.** The Alerts tab and Workers Logs
> are the entire safety net. A sweep that can fail without landing in one of them
> is a source failure with no way to notice it.

Concretely, that is why `runAlertTick` is `await`ed in `scheduled()` rather than
`ctx.waitUntil`'d (an async `scheduled` handler's promise is already awaited, so
`waitUntil` buys nothing — while awaiting is what makes a throw show up as a
**failed invocation** in Workers Logs), why `sendEmail` returns a result instead
of throwing, and why `alert_deliveries` records the sends that never happened.

### Why the budget guard lives in exactly one file

A person pressing Search does not need protecting from a call they chose to
spend, and a guard on that path would turn a deliberate action into a baffling
refusal — so the interactive search and enrich paths **spend first and report
after**, unconditionally.

A scheduled sweep is different: it spends without anyone watching, which is
precisely the case a budget guard is for. So the guard exists, in one file,
scoped to one caller:

> **Only `alerts/budget.ts` reads the quota before spending.** A budget guard
> anywhere else duplicates the one place this codebase trusts to gate a call.

`grep` for `source_quota` and you should find `recordQuota` (writers) and
`readBudgetState` (the one reader that gates). §7 is what the guard actually
protects, which is not the quota — it is the reserve.

---

## 2. One tick, 25 calls

**A Cron Trigger with an interval under one hour gets 30 SECONDS of CPU. An
hourly one gets 15 minutes.**

That platform limit is the whole shape of this feature. Waiting on seats.aero is
I/O and costs no CPU; *parsing* is CPU, and a seats.aero page with
`include_trips` is up to 500 rows at ~9.9 KB each. Subrequests are not the
constraint (10,000 per invocation, though D1 calls count against it) — CPU is.

So:

- the cron is `*/15 * * * *`, a **heartbeat**, not a cadence;
- the tick is capped at `ALERT_MAX_CALLS_PER_TICK` (25) outbound calls, and
  **that cap is the whole bound** — a tick sweeps due routes, most overdue
  first, until the cap is spent;
- a route that needs more resumes on the next tick through the **same
  `run_continue` mechanism** the HTTP search uses — `runSearchPass` returns
  `paused: true`, and the next tick finds the still-`running` run row and
  reopens it (`openSearchRun({ resumeRunId })`), so one route's coverage stays on
  one run row.

How often any *one* route is actually swept is derived (§4), not configured.

**Raising a tick's workload without raising the cron interval is how you get
silent CPU-limit kills.** If you ever want a bigger tick, the interval has to go
hourly first. `ALERT_MAX_CALLS_PER_TICK` is that number; nothing else is.

### Why the bound is CALLS and not ROUTES

This used to sweep **at most one route** per tick, which reads as the same rule
and is not. Calls are what cost CPU. A route count is a proxy that is only
honest when a route costs a whole tick's worth, and a narrow route costs **one
call**.

Measured on the author's own four routes — each a two-or-three-day window, one
chunk, no hubs, so one call apiece:

- `sweepPacing` returned `every 15m` (the floor), because a 4-call cycle divides
  into a 600-call budget 150 times;
- a tick spent **1 of its 25 calls** and moved on, so the four round-robined at
  **60m** — four times slower than the cadence the Alerts tab was quoting, which
  is exactly the "a page quoting a cadence the scheduler does not keep" failure
  §4 exists to prevent;
- the day's alert spend was **96 calls against a 600 budget**, every day;
- and no digest had **ever** flushed — see §8.

Sweeping to the call cap fixes all three at once, and **it does not raise the
tick's ceiling**: one route could already spend all 25 calls in a tick, so four
routes spending four calls is strictly less work than the shape already
permitted. What changed is that the budget stops going unused.

Two details in the loop are load-bearing:

- **The budget guard is re-read per route**, not once per tick. `finishRun` has
  written the previous route's `calls` by the time the next one asks, so
  self-accounting (§7) stays honest *as* the tick spends and the reserve is
  measured against what is actually left.
- **`exhausted` breaks the loop; `reserve` only skips that route.** `exhausted`
  is `remaining <= 0`, which no cheaper route can pass; `reserve` compares
  against `estimatedCost`, so a cheaper route later legitimately can.

`POST /api/alerts/run`'s `force` still sweeps exactly one route, because its
argument is a route id and "sweep this one and tell me what happened" is the
question it exists to answer.

One smaller consequence of the same budget: the sweep passes
`captureBudgetBytes: 0` — nobody is watching, so holding megabytes of captured
JSON to throw away is pure CPU.

`runAlertTick` also accepts an optional `deadlineAt`, a wall-clock stop
`runSearchPass` checks between tasks (the unattended counterpart to the
`AbortSignal` the HTTP caller relies on). `scheduled()` does not currently pass
one; `maxCalls` is what bounds a tick today.

---

## 3. A tick, step by step

`runAlertTick(env, { now?, deadlineAt?, force? })` — `api/src/alerts/sweep.ts`.

It **returns a summary and never throws on one route's failure**: a single
unsearchable route must not stop the cycle, and its failure is already durable on
its own `search_runs` row.

1. **Identity, fail-closed.** `scheduled()` runs **no middleware** — not `cors`,
   `csrf`, `gate`, `identity`, or `applySecurityHeaders`. Identity is
   `env.APP_USER_EMAIL` read directly, and an unset value returns
   `pacing: "no_app_user_email"` and does nothing, because
   `search_runs.user_email` is `NOT NULL` and there would be no account to
   attribute a sweep to.
2. **Read the routes** (`alertRouteRows`) — every `alerts_enabled = 1` route for
   that account, with `alert_last_attempt_at`, `last_checked_at`,
   `alert_consecutive_failures`, and `observed_calls`: the `calls` of that
   route's last finished alert run, looked up by `search_runs.route_id`. It is
   `route_id` and not the `origin`/`destination` scalars because those are only a
   route's *primary* airports, so two routes over one city pair would otherwise
   be priced off each other's measurements.
3. **Price and pace** — `planSeatsAeroChunks` per route for the chunk count, then
   `sweepPacing` (§4). An unaffordable set **returns**; it does not clamp and does
   not sweep.
4. **Pick the due routes** — `dueRoutes(...)`, most overdue first. The tick
   walks that list until `ALERT_MAX_CALLS_PER_TICK` is spent (§2).
5. **Ask the guard, per route** — `readBudgetState` + `decideSweep` (§7). A refusal is
   recorded as `skipped: [{ routeId, reason }]` and **no run row is written**:
   `search_runs.status` has no `'skipped'`, and a row that spent nothing would
   pollute the `observed_calls` measurement that feeds step 3.
6. **Sweep it** — `sweepRoute` (below), which returns the calls it spent so the
   tick can decrement its remaining budget. A route that never reached
   `runSearchPass` spent nothing and reports nothing, so a tick is not shortened
   by a route that failed for free.
7. **Flush, if the cycle is complete** — §8.

### `sweepRoute`

1. **Stamp `alert_last_attempt_at` first, before anything can fail.** Stamping it
   only on success would let a permanently-failing route be due on every single
   tick and spend the whole day rediscovering the same failure.
2. Look for a `running` alert run on this route and resume from
   `tasks_ok + tasks_failed` if there is one.
3. `planSearchPass` → `openSearchRun` → `runSearchPass`. A planning or opening
   failure calls `noteFailure` (`alert_consecutive_failures += 1`) and returns.
4. `pass.totals.ok === 0` is also a failure. Any success resets the counter to 0.
5. **`pass.paused` returns early without filing anything.** A half-searched route
   would let the digest describe half a route as though it were the whole answer.
6. **Baseline check** — §5.
7. `selectAlertable` (§6) → `fileOutbox` (§8).

---

## 4. Pacing — how often

`api/src/alerts/pace.ts`. All pure, and that is the point:

> **The scheduler and the Alerts tab call the same functions.** `GET
> /api/alerts/schedule` derives nothing of its own — it runs `sweepPacing`,
> `dueRoutes`, `routeSweepCost` and `decideSweep`, the same code, over the same
> rows. A second implementation would produce a page quoting a cadence the
> scheduler does not keep, and **a wrong number you trust is worse than no
> number.** `POST /api/alerts/run` holds the same line the hard way: it calls
> `runAlertTick` itself rather than reimplementing a tick.
>
> The SPA obeys this too. `app/src/lib/alerts.ts` names and orders states; it never
> computes `due`, `windowExpired` or `intervalMinutes`, which all arrive already
> decided.

### What a route costs — `routeSweepCost`

The *direction* of the guess matters more than its accuracy: guessing low
overspends the day's allowance, guessing high just sweeps less often than it
could. So — **pessimistic while ignorant, measured once measured.**

The unit is the **task**, not the date chunk: `tasks = chunks × queriesPerChunk`,
and a route with `via` hubs plans two queries per chunk because `SFO->ICN` and
`ICN->KTM` are different markets (`docs/SEATS-AERO.md` §12). Counting chunks
would price such a route at half what it spends — which is guessing low, the one
direction this table exists not to.

| state | cost |
|---|---|
| `chunks <= 0` (window entirely in the past) | `0` — it cannot spend anything |
| never swept | `tasks × SEATSAERO_MAX_PAGES` — the ceiling |
| swept before | `max(observedCalls, tasks)` |

`max(observed, tasks)` rather than `observed` alone because a **paused** sweep
records only the calls that pass spent; a route resumed across three ticks would
otherwise look a third as expensive as it is.

`AlertRouteCost` is built in ONE place (`alertRouteCosts`, `alerts/sweep.ts`) and
read by both the scheduler and the Alerts tab, and `AlertScheduleRoute` carries
`queriesPerChunk` so the page's `estimatedCalls` still follows from the chunk
count it shows.

### The cadence — `sweepPacing`

```
cycleCost     = Σ routeSweepCost(searchable routes)
cyclesPerDay  = floor(dailyBudget / cycleCost)
interval      = clamp(ceil(1440 / cyclesPerDay), MIN_SWEEP_MINUTES=15, MAX_SWEEP_MINUTES=1440)
```

More routes, or wider ones, means each is swept less often. That is the whole
model, and it is why the Alerts tab shows cadence as *derived* rather than as a
setting.

- **The floor is 15 minutes** however much allowance is spare: seats.aero serves
  rows out of its own cache, so re-asking faster mostly re-reads the same answer
  and spends a call to learn nothing.
- **Unaffordable is a return value, not a clamp.** `floor(budget/cost)` is zero
  the moment one cycle costs more than a day's allowance, and dividing by it
  yields `Infinity` — which would clamp silently to the daily maximum and present
  a route that *cannot be afforded* as one that is merely slow. You would then
  wait a day for an email that was never going to arrive. `sweepPacing` returns
  `{ affordable: false, reason: "no_routes" | "cycle_exceeds_budget" }` and the
  Alerts tab renders it as a red banner naming the fix (narrow a window, drop a
  route, raise `ALERT_DAILY_BUDGET`).
- **An expired-window route is excluded from the cost model and named**
  (`unsearchable`), not counted as free — a free route would drag down the cadence
  of the routes that actually work.

### Which route is due — `routeDueAt` / `dueRoutes`

Two clocks are consulted and they answer different questions:

```
dueAt = max( alertLastAttemptAt + interval × 2^min(failures, 3),
             lastCheckedAt      + interval )
```

- **`alert_last_attempt_at`** is the pacing clock, written on every attempt.
  Pacing off `last_checked_at` instead would hot-loop a permanently-failing
  route: that column is never written when a run fails, so the route would be due
  on every tick forever.
- **`last_checked_at`** is a floor, so a route somebody searched by hand two
  minutes ago is not immediately re-swept.
- **Back-off applies to the attempt clock only**, capped at ×8. Eight failures in
  a row is a route that needs a person, not a faster retry. Editing a route's
  settings resets the counter, so fixing a broken window does not still wait out
  the old penalty.
- A route with `chunks <= 0` is **never due** — it would refuse at
  `planSearchPass` and burn a tick to learn what the plan already knows.
- **`dueRoutes` allows half a tick of grace**, and that is a fix rather than a
  nicety — see below.

#### Why the due test has grace — a measured 2× slowdown

A route is only ever swept **on a tick**, so the cron's period is the resolution
of every cadence here. Requiring the interval to be *strictly* elapsed therefore
rounds each wait up to the next tick, **plus one more whenever the due time lands
a hair past it** — and it always did:

| what | when | why |
|---|---|---|
| `alert_last_attempt_at` | the tick's own clock | stamped first thing in `sweepRoute` |
| `last_checked_at` | **1.3 – 4.6 s later** | written when the search finishes |

`routeDueAt` takes `lastChecked + interval` as a floor, and the cron is regular
to the millisecond (900,001 ms between the two ticks that wrote those rows). So
the floor lands a second or two *after* the next tick, every single time: not
due, skipped, swept on the one after. Four routes the Alerts tab paced at
`every 15m` were swept **every 30 minutes, exactly** — 22:45, 23:15, 23:45,
00:15 — for as long as `search_runs` goes back.

This is not the one-route-per-tick bug in §2. That one was fixed; this survived
it, because sweeping every *due* route does nothing when the route is not due.

`dueGraceMs` is half a tick (`SWEEP_TICK_MINUTES`, mirrored from
`api/wrangler.toml`), which makes a route due on the tick **nearest** its due
time rather than the first tick strictly after it. It cannot sweep anything
early: there is no tick between one sweep and its successor to be early on. It is
bounded by half the *interval* as well, so a cadence longer than the cron still
waits for its own tick — a 30-minute cadence is not pulled forward to 15.

---

## 5. The baseline, and the wall of `new`

**The first sweep of a route files nothing.** This is the single most important
line in `sweepRoute`.

`diffAvailability` compares against the last snapshot **for that source**. A route
that has not been searched recently therefore classifies everything it finds as
`new`, plus a wall of `gone` for everything that aged out — thousands of changes,
truncated to `MAX_STORED_CHANGES` (200), emailed as a meaningless *200 of 3000*
digest. Once. And then never again, because the snapshot is now current — so the
cost of getting this wrong is one useless email and a permanently lost first
impression.

So `alert_last_digest_at` is a third clock, and it is the **suppression** flag:
`NULL` means the next sweep ingests normally, emails nothing, and just stamps the
column. The Alerts tab calls that state **"baseline pending"** and says so, since
"I turned it on and got nothing" would otherwise read as a fault.

### The baseline is the snapshot, not the clock — `baselineOnEnable`

When alerts are switched **off → on** (`PATCH /api/tracked-routes/:id`), the
column is re-decided:

```ts
alert_last_digest_at = baselineOnEnable(last_checked_at, now)
// fresher than MAX_SWEEP_MINUTES (24h)  → now   (armed immediately)
// older, or never searched             → null  (silent baseline sweep first)
```

The question is not *"has the scheduler swept this route"* but *"is there a
recent enough snapshot to diff against"* — and a route somebody searched by hand
ten minutes ago already has one. Clearing the clock there would spend a route's
full call cost computing a diff against fresh data and then throw the answer
away, and make the user wait another whole interval for the first email.

The cutoff is `MAX_SWEEP_MINUTES` because that is the slowest cadence the pacer
will ever claim: data fresher than that is no staler than what a normal alert
cycle diffs against.

**Known edge, deliberately not handled.** `last_checked_at` is one timestamp for
the whole route, so a search that covered only part of the window looks as fresh
as one that covered all of it. Widening a window and enabling alerts in the same
breath can still produce one noisy digest. Bounding it properly would mean
recording per-slice check times, which is a whole stored table for one avoidable
email — the trade that got that table deleted (`migrations/0010`).

---

## 6. What is worth an email

`api/src/alerts/select.ts`, pure, called as
`selectAlertable(changes, findKeys, rule, routeFilters)`.

### The four types

`new | more_seats | price_drop | gone` (`ChangeType` in `api/src/domain/diff.ts`),
stored per route as a JSON array in `alert_on`.

**The default is `["new", "price_drop"]`.** `gone` is out because most
disappearances are cache churn or dates ageing off the front of the window, and
because it is the one type that cannot be intersected with the finds query.
`more_seats` is out because a seat count rising on space you already knew about
is rarely why you are watching.

`price_drop` additionally has to clear `alert_min_drop_pct`, **default 5, not 0**
— seats.aero re-quotes constantly and a 1% movement is noise that would train you
to ignore the mail.

> **`[]` is rejected at the API with a 400, not stored.** The neighbouring
> columns (`cabins`, `currencies`) treat `NULL` and `[]` alike as "no filter";
> here `[]` would mean the opposite — alerts on, nothing ever fires — which is the
> single most plausible way for this feature to look broken while behaving
> exactly as configured. `NULL` is the only way to say "default", and
> `parseAlertTypes` falls back to the default set on a corrupted value for the
> same reason.

### The intersection, and why it is SQL

The other half of the question is *would this route's own pane show this find?*
— cabins, currencies, seats, nonstop, and the cross-source collapse. That is
**not** re-implemented in TypeScript. `sweepRoute` runs `routeFindKeys`, which is
the Routes page's own CTE (`findsCte` + `ROUTE_FINDS_MATCH` + `ROUTE_FINDS_SEATS`
in `api/src/db/finds.ts`) restricted to the one route, and hands the resulting
`changeKey` set in.

The reason is worth stating, because writing the filter in `select.ts` would have
been the obvious thing to do. "Can the couple book this?" already exists twice —
`bookableCurrencies()` in `providers/filter.ts` and the currency clause in
`ROUTE_FINDS_MATCH` — and CLAUDE.md already flags that those two must be kept in
step. A third copy would be the only one blind to the cross-source collapse and
to the cash-fare carry-forward, so it could fire on a snapshot another source has
already superseded: **an email about a seat the app itself does not show.**

`changeKey` is `route_key|program|cabin`, and `routeFindKeys` builds its set with
exactly that concatenation. The two must not drift.

### `gone` bypasses the intersection, and must

There is no current row for a disappearance, so intersecting it would silently
drop every one. `gone` is filtered on what the `ChangeSummary` itself carries
(cabin, `previousSeats` vs `min_seats`) instead — which means a route's currency
and nonstop filters do **not** apply to it. One more reason it is opt-in.

Finally, `selectAlertable` de-duplicates by key: one sweep can apply several
chunks and a resumed sweep several passes, so the same key can legitimately
arrive twice.

---

## 7. The budget guard and the reserve

`api/src/alerts/budget.ts`. **Nothing else may import this module.**

What it protects is not the quota for its own sake. It is the **reserve**: the
scheduler stops well short of the day's ceiling so that a human pressing Search
at 9pm gets an answer instead of a 429 caused by a robot.

Three numbers, and they are not the same thing:

| | default | what it bounds |
|---|---|---|
| the key's ceiling | 1000/UTC day | seats.aero Pro, everything shares it |
| `ALERT_DAILY_BUDGET` | 600 | what **automation** may spend of it |
| `ALERT_MANUAL_RESERVE` | 300 | what must remain unspent, for a person |

```ts
decideSweep({ observation?, selfSpentToday, estimatedCost, reserve, dailyBudget })
  remaining <= 0                              → { go: false, reason: "exhausted" }
  remaining - estimatedCost < reserve         → { go: false, reason: "reserve" }
  selfSpentToday + estimatedCost > dailyBudget→ { go: false, reason: "reserve" }
  otherwise                                   → { go: true }
```

The reserve test compares against what would be left **after** the sweep, which
is the assertion `budget.test.ts` pins by name.

### The absent-observation case is the one that matters

`source_quota` is written only when a call is actually made — by the search and
enrich paths reading `X-RateLimit-Remaining` off a live response, through the
shared `recordQuota`. So on most days, days nobody manually searched, **there is
no row at all when the first tick fires.** Two obvious answers are both wrong:

- *Refuse until something has been observed.* The scheduler would then never fire
  on any day it was the only thing running, which is nearly all of them. The
  feature would die silently — precisely the failure §1 is about.
- *Assume a full 1000.* Optimistic in the one direction that overspends, on the
  one day it mattered.

So it **self-accounts**: last known limit (or `ASSUMED_DAILY_LIMIT = 1000`) minus
`SUM(search_runs.calls)` for runs started since midnight UTC. An honest number
derived from facts we hold, corrected by the first real observation of the day.
`SweepDecision.basis` reports which of the two it used, and the Alerts tab shows
it, because "read from seats.aero's own header" and "counted from our own
records" deserve different confidence.

`source_quota` is keyed `(source, day)` with `day` in **UTC** — that is when the
allowance resets, regardless of where the caller is standing — so yesterday's
exhausted count is simply not selected and the caller falls back to
self-accounting exactly as it would on a day with no row.

---

## 8. The outbox, and when a digest goes out

The product rule is **one digest per sweep cycle, grouped by route.** The
platform rule is **25 calls per tick** (§2), which a wide enough set will not
fit in. Those only coexist if a change outlives the tick that found it — hence
`alert_outbox`.

- `fileOutbox` inserts with `UNIQUE (route_id, change_key)` and
  **newest-wins** on conflict: a route swept twice before a flush must not report
  the same seat twice, and the later observation is the true one. Batched 50 at a
  time.
- The key is scoped by `route_id` because two tracked routes can legitimately
  watch the same city pair with different filters and different recipients.
- **A tick that dies loses nothing.** The flush is a separate step from the sweep,
  and anything already filed is still there next time.

A route set narrow enough to fit inside one tick now completes its cycle in that
tick and flushes there. It could not before: with one route per tick, four
routes on a 15-minute interval left three of them permanently older than one
interval, so `cycleComplete` never once returned true and **no digest was ever
sent** — three changes sat in `alert_outbox` for four days and `alert_deliveries`
was empty. The outbox is still required for a set that spans ticks; what it is
not is a place changes go to stay.

`cycleComplete(email, intervalMinutes, now)` is one query and asks two things:
**no route is due** (`alert_last_attempt_at` older than one interval, or NULL) and
**no alert run is still `running`**. Only then does a digest describe a complete
pass rather than an arbitrary slice of one.

The flush is skipped entirely when pacing is unaffordable — `cycleComplete` is
defined in terms of the interval and there isn't one. That state is only
reachable by forcing a sweep (§10); the outbox holds until the pacing problem is
fixed.

> **A gap worth knowing about.** `cycleComplete`'s `due` count is plain SQL over
> `alerts_enabled = 1` and has no notion of chunks, while `dueRoutes` skips any
> route whose window has expired. So an expired-window alert route is never
> swept, its `alert_last_attempt_at` is never stamped, it counts as due forever,
> and **the cycle never completes — no digest flushes for any route** while it is
> enabled. The Alerts tab names the offending route (*window expired*) and tells
> you to move the window or turn alerts off, which is also the fix; the tab is
> doing its job, but the symptom you notice first is silence from the routes that
> are working. If this is ever tightened, the honest fix is to give the `due`
> subquery the same window test the planner applies (`date_end >= today`) rather
> than to loosen the flush condition.

---

## 9. The digest, and delivery

`api/src/alerts/digest.ts` renders strings and decides nothing; the Worker
half only hands them to Resend.

- **One digest per recipient, not per route.** `groupForRecipients` buckets by
  `alert_email ?? APP_USER_EMAIL`: one person watching three routes gets one email
  with three sections.
- **Routes swept this cycle with nothing to say are named, not omitted** — the
  `quiet` list, rendered as *"Also checked, nothing new: …"*. Since no failure
  email exists, "three routes checked, two quiet" and "only one route ran" are
  different facts and a digest listing only the noisy route cannot tell them
  apart.
- **A recipient whose routes were all quiet gets nothing.** There is no news, and
  this app does not send "still working" mail.
- Subject names the route when there is only one (`BertBooker — 3 changes on
  SEA/PDX ⇄ NRT/HND`), and counts routes otherwise — that is the line you read in
  a notification without opening anything.
- Both a `text` and an `html` body, sharing one `describeChange` so they cannot
  describe the same event differently. Everything interpolated is `escapeHtml`'d:
  airport, program and cabin codes all come out of a database filled by parsing
  other people's payloads, and HTML-injecting your own inbox is still a bug.
- `APP_URL`, if set, becomes an *Open BertBooker* link. Unset omits it.

### Resend, and the recipient allowlist

`api/src/alerts/email.ts`. **This is the Worker's second and last outbound host**, and
the distinction is what makes it allowed: Resend is not a data source, it is a
delivery channel — a keyed vendor API that authenticates the *key*, not the
client, exactly like seats.aero. Nothing about the airline prohibition changes.

`sendEmail` **returns a result rather than throwing**, and the three statuses are
kept apart on purpose:

| status | meaning |
|---|---|
| `sent` | the provider accepted it; `provider_message_id` recorded |
| `failed` | we tried and were refused — the provider's own body is in `error` |
| `skipped` | **we never tried** — no `RESEND_API_KEY`, no `ALERT_FROM`, or the recipient is off the allowlist |

`skipped` vs `failed` is our configuration vs theirs, and they are fixed in
different places. An unset key means sweeps still run and still ingest, and every
digest is recorded as skipped with the reason. **Never a silent drop:** with no
failure mail, `alert_deliveries` is the only trace an undelivered digest leaves.

**Recipients are allowlisted**, and the list is the `alert_recipients` table
(migration `0008`), edited in the app under **Settings → System**. With one
shared password as the only auth, an unchecked per-route `alert_email` would
make this an arbitrary-recipient sender on a verified domain, and the domain's
sending reputation is not something a typo should be able to spend.

It is enforced twice, and the two are not redundant: at write time in
`validateAlerts` (400 `recipient_not_allowed`) so a bad address is never stored,
and again at send time in `sendEmail` so a stored address that has since been
REMOVED from the list does not go out. The route form's "Send to" is a Select
over this list rather than a text box, so the write-time refusal is a backstop
rather than how anyone finds out.

`APP_USER_EMAIL` is always allowed and is **never a row** in the table, so an
empty table still means "only the account's own address" — the safe default
rather than the permissive one — and never "this deployment can email nobody".
It is also what a NULL `alert_email` resolves to, so it cannot be removable.

**Deleting a recipient a route still points at is refused** (400
`recipient_in_use`, naming the count). Not tidiness: such a route's digest is
recorded `skipped`, and because only a successful send clears `alert_outbox`,
the rows stay and every following cycle retries the same refusal forever, with
no failure mail to announce it. Point the route elsewhere first.

This used to be `ALERT_ALLOWED_RECIPIENTS`, a CSV env binding — which meant a
`wrangler secret put` and a redeploy to add one address, and a list nothing in
the app could show you.

**Double-send is guarded on both sides**: `UNIQUE (sweep_id, to_email)` in
`alert_deliveries`, and a matching `Idempotency-Key` header
(`SHA-256(sweepId:recipient)`) that Resend de-duplicates on for 24 hours.
`sweep_id` is a uuid minted per flush, not a foreign key — one sweep can cover
several routes and therefore several runs, which is what `run_ids_json` records.
There is deliberately no `alert_sweeps` table.

**Only a successful send clears the outbox** and stamps `alert_last_digest_at`. A
refused send leaves the rows intact so the next cycle tries again.

---

## 10. The Alerts tab, and the local dev loop

### The four endpoints

| endpoint | what |
|---|---|
| `GET /api/alerts/schedule` | pacing, budget, email config, and every alert route's state |
| `GET /api/alerts/runs?limit=` | `search_runs WHERE trigger = 'alert'` |
| `GET /api/alerts/deliveries?limit=` | `alert_deliveries`, newest first |
| `POST /api/alerts/run` | fire one tick by hand — **local dev only** |

`GET /schedule` also returns `manualTick`, i.e. whether `POST /run` exists on this
host, answered server-side rather than by making the SPA probe for a 404: a
button that appears only to fail is worse than no button.

### The page is the feature's safety mechanism, not its status board

`app/src/pages/alerts/AlertsPage.tsx` is ordered **problems, cadence, routes, history** —
anything that would make the mail stop is above the fold. That ordering is why
the page is a composition of six named sections rather than one long body: the
sequence *is* the design, so it should be legible in one screen of code
(`ProblemBanners`, `CadencePanel`, `AlertRoutesTable`, `SweepHistory`,
`DeliveriesTable`, and `TickPanel` for a hand-fired tick). The banners cover: no
email configured, `cycle_exceeds_budget`, a blocked budget guard, failing routes,
expired windows, and undelivered digests. `app/src/lib/alerts.ts` reduces a route to
one of five states, first-match-wins from most-wrong to most-ordinary:

`expired` → `failing` → `baseline` → `due` → `watching`

A failing route whose window has *also* expired reports as `expired`, because that
is the one you can actually fix.

### `POST /api/alerts/run`

404s off a loopback host — in production this should be indistinguishable from a
route that was never written. It sits behind `gate` regardless; the host check
decides what a developer can reach, not who is let in.

Three properties, each load-bearing:

- **It is `runAlertTick`, not a copy of it.** Anything it can exercise, the cron
  does identically.
- **It returns the whole `TickResult`** — `sweptRouteIds`, `skipped` with reasons,
  `flushed`, `pacing` — and the page prints all of it. A tick that swept nothing
  has to say why, or this becomes one more surface on which a broken sweep and a
  quiet one look the same.
- **`routeId` bypasses cadence, never the budget guard.** The due filter and the
  pacing-affordability return are both answers to *how often*, and waiting four
  hours to find out whether a code change works is the entire reason this exists.
  `decideSweep` answers *can this be paid for* — a different question — and runs
  unchanged. A forced sweep still stamps `alert_last_attempt_at`, because it
  really did spend the calls, and a forced route with an expired window is still
  refused (`window_expired`).

These buttons spend real seats.aero calls against today's allowance. The page
says so.

---

## 11. Configuration

All optional except identity; defaults are in `bindings.ts` / `ALERT_DEFAULTS`.
Production: `wrangler secret put NAME`. Locally: a line in `api/.dev.vars`
(the only environment file; `wrangler dev` does **not** reload it).

| name | default | unset means |
|---|---|---|
| `APP_USER_EMAIL` | — | **the cron fails closed** — no account to attribute a run to |
| `RESEND_API_KEY` | — | sweeps run and ingest; every digest recorded `skipped` |
| `ALERT_FROM` | — | same as a missing key. Must be on a Resend-**verified** domain |
| `ALERT_DAILY_BUDGET` | 600 | automation's share of the key's 1000/day |
| `ALERT_MANUAL_RESERVE` | 300 | calls held back for a person |
| `ALERT_MAX_CALLS_PER_TICK` | 25 | one tick's cap before pausing the route |
| `APP_URL` | — | the digest omits its link |

`ALERT_FROM`'s SPF/DKIM records are a **deploy prerequisite, not a code step** —
until they exist every send fails with the provider's own message in
`alert_deliveries.error`. The sending domain and the app's own hostname are
independent facts; there is no requirement that they match.

---

## 12. Schema

`migrations/0001_init.sql`. On `tracked_routes`:

| column | notes |
|---|---|
| `alerts_enabled` | 0 by default, so a new route schedules nothing |
| `alert_email` | NULL = the account's address. Checked against `alert_recipients` on write |
| `alert_on` | JSON `ChangeType[]`. NULL = default set; `[]` refused |
| `alert_min_drop_pct` | default 5 |
| `alert_last_attempt_at` | **the pacing clock** — every attempt, pass or fail |
| `alert_last_digest_at` | **the email clock** — NULL suppresses (§5) |
| `alert_consecutive_failures` | back-off; reset on success and on edit |

Plus `last_checked_at`, the coverage clock, written by `search/run.ts` at the
end of any pass that claimed coverage — so the sweeper reads it but does not
write it itself. **Three clocks, and collapsing any two re-creates a bug the
others exist to prevent.** In particular `alert_last_attempt_at` is stamped
BEFORE the search and the other two after it, which is what stops a
permanently-failing route being due on every tick.

`idx_tracked_routes_alerts` was partial (`WHERE alerts_enabled = 1`) because the
scheduler's one hot query was "which alert-enabled route is most overdue".
**Dropped by `migrations/0011`:** that question stopped being SQL when
`dueRoutes` (`alerts/pace.ts`) became a pure function over rows already in
memory. It was the only index on `tracked_routes`, so it was also the only
reason the pacing-clock UPDATE billed two D1 rows instead of one.

`alert_outbox` — §8. `alert_deliveries` and `alert_recipients` — §9. Neither `type` nor
`search_runs.trigger` carries a CHECK constraint: a new transition type should
not need a migration to become storable.

All `alert_*` columns and the outbox/delivery tables are defined in
`migrations/0001_init.sql`; there is no separate alerts migration.

---

## 13. Failure modes

| symptom | cause | where it shows |
|---|---|---|
| no mail, ever, on a new route | baseline sweep — working as designed | Alerts tab: *baseline pending* |
| no mail, and the tab says *not running* | `cycle_exceeds_budget` — the routes cost more than a day | red banner naming the fix |
| no mail, banner says sweeps paused | budget guard: `reserve` or `exhausted`. Clears at 00:00 UTC | warning banner |
| sweeps run, nothing arrives | `RESEND_API_KEY`/`ALERT_FROM` unset, or the recipient is off the allowlist — add it under **Settings → System** | `alert_deliveries.status = 'skipped'` |
| sweeps run, sends refused | unverified sending domain, bad key | `status = 'failed'`, provider body in `error` |
| a route stops being swept | window fell into the past; every sweep would refuse before the first call | *window expired*, and it is excluded from the cost model |
| **every** route goes quiet, but sweeps look fine | an expired-window route blocks `cycleComplete`, so nothing flushes — see the note in §8 | *window expired* on the offending route |
| a route slows down | `alert_consecutive_failures` back-off, up to ×8 | *failing*, with the count |
| EVERY route swept at twice the cadence the tab quotes | `SWEEP_TICK_MINUTES` no longer matches the cron in `wrangler.toml`, so the due test has the wrong grace and each route waits for the tick after the one it was due on (§4) | *last swept* consistently one whole interval stale, on every route at once |
| **no invocations at all** | `APP_USER_EMAIL` unset, or the tick threw | **Workers Logs** — `wrangler tail bertbooker` — and the Cron Triggers tab |

That last row is the one with no in-app surface, which is exactly why
`runAlertTick` is awaited rather than fire-and-forget.

---

## 14. Tests

Everything interesting is pure, and offline:

- `api/src/alerts/alerts.test.ts` — cost, pacing (including that unaffordable
  **refuses** rather than clamping), due-ness and both clocks, back-off,
  `baselineOnEnable` at the cutoff, `parseAlertTypes`, `selectAlertable`
  (including that `gone` bypasses the intersection and that a drop coinciding with
  more seats classifies as `more_seats`).
- `api/src/alerts/digest.test.ts` — rendering, escaping, grouping, and that a
  recipient whose routes were all quiet gets nothing.
- `api/src/alerts/budget.test.ts` — the guard, both bases, and the UTC day.
- `app/src/alerts.test.ts` — the health ladder's order and completeness.

`npm test` runs all of it. There is no test that drives a real tick against D1;
`POST /api/alerts/run` is the loop that covers that ground, by hand.

---

## See also

- `docs/SEATS-AERO.md` — the Partner API, chunking, `SEATSAERO_MAX_PAGES`,
  `include_trips`, quota, and every payload trap. A sweep is one of its callers.
- `docs/SOURCES.md` — the source contract, the ingest rules, and the
  credential-vs-client test that lets seats.aero and Resend in and keeps airlines
  out.
- `CLAUDE.md` — the invariants, including the two this feature exports: unattended
  work must never fail invisibly, and only `alerts/budget.ts` reads the quota
  before spending.
