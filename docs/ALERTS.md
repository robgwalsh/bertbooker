# Alerts — the scheduled sweep

A Cron Trigger re-runs the same search engine a person drives from the Routes
page, on the routes that asked for it, and emails a digest of what moved.

That is the whole feature, and almost none of the code is about email. It is
about spending a metered allowance with nobody watching, inside a runtime that
gives an unattended invocation 30 seconds of CPU, without ever going quiet in a
way that looks like good news.

```
  cron */30                                        Resend
      │                                              ▲
      ▼                                              │
  runAlertTick ──▶ pace ──▶ budget ──▶ search/run ──▶ apply ──▶ finds
   (tick.ts)        │         │            │                     │
                    │         │            └── changes ──────────┘
                    │         │                    │
                    │         │              selectAlertable
                    │         │                    │
                    │         │                    ▼
                    │         │              alert_outbox
                    │         │                    │
                    └─────────┴── cycle complete ──┴──▶ digest ──▶ alert_deliveries
```

Everything below the engine is shared: a sweep produces `runs` rows, `finds`
rows and coverage claims identical to a button press, and is told apart only by
`runs.trigger = 'alert'`. `docs/SEATS-AERO.md` owns the search itself;
`docs/SOURCES.md` owns ingest. This file owns the *unattended* part.

---

## 1. The rule the whole feature is built against

**No email is ever sent when a sweep breaks — only when it finds something.**

That is a product decision, not an omission, and it has a hard consequence: a
scheduler that is blocked, refused, throttled, misconfigured or crashing
produces *exactly the same silence* as one that ran and found nothing. Silence
is the success case and the failure case at once.

So the rule that constrains code everywhere in this feature:

> **Unattended work must never fail invisibly.** Every outcome a tick can have
> — including the ones where it did nothing, and especially the ones where a
> digest was not sent — is written to a table a page can read.

The safety net is exactly two things, and there is no third:

- **The Alerts tab** (`app/src/components/pages/alerts/`), which reads `runs`,
  `alert_deliveries` and the schedule, and puts problems above the fold.
- **Workers Logs**, which is why `scheduled()` awaits the tick rather than
  handing it to `ctx.waitUntil` — an awaited throw is a *failed invocation* in
  the dashboard, a detached one is not.

Three things fall directly out of it:

- `sendEmail` returns a result instead of throwing, and every outcome —
  including "we never tried" — becomes an `alert_deliveries` row.
- `runAlertTick` returns a `TickResult` instead of throwing. One unsearchable
  route must not end the cycle, and its failure is already durable on its own
  `runs` row.
- `DELETE /api/settings/recipients/:id` refuses to remove an address a route
  still points at (§9). Allowing it would manufacture exactly this failure from
  a delete button.

**The budget guard is scoped to this one caller.** `scheduler-budget.ts` is the
only code in the app that reads the quota *before* spending; every interactive
path spends first and reports after, because nobody needs protecting from a call
they deliberately asked for. `db/sourceQuota.ts:selectBudgetRows` says on the
function that it has one caller and must keep having one. Do not add a budget
check anywhere else — a second one is a second answer to "may this be spent",
and the argument for allowing unattended spending at all rests on there being
one.

**It fails closed.** `scheduled()` runs no middleware — no `gate`, no
`identity`, no CORS, no security headers — so identity is read straight off
`env.APP_USER_EMAIL`, and a tick with it unset returns `no_app_user_email`
having spent nothing. Unset means there is no address a digest could go to, so a
sweep could only spend calls nobody would ever hear about.

---

## 2. The tick, and the two limits that shape it

The cron is `*/30 * * * *`, declared in `api/wrangler.toml` and **mirrored** as
`SWEEP_TICK_MINUTES` in `pace.ts`. Change one and change the other; the pacing
model needs the number and cannot read the toml.

Two limits do all the shaping:

**A Cron Trigger firing more often than hourly gets 30 seconds of CPU.** Not
wall clock — CPU. Waiting on seats.aero is nearly free; *parsing what comes
back* is not, and a page of up to 1000 rows carrying `include_trips` itineraries
is the expensive thing this code does. So the cron passes
`captureBudgetBytes: 0` into the engine: nobody is watching, and holding
megabytes of captured JSON in order to throw it away is pure CPU against that
budget.

**`ALERT_MAX_CALLS_PER_TICK` (default 25) is a CALL cap, not a route count**,
and the distinction is the point. CPU is spent per page parsed, so a bound
expressed in routes prices a one-chunk route the same as a hub route with a
year-long window. A tick spends up to 25 calls across as many routes as that
buys: a route that alone costs the whole tick still gets the whole tick, and a
set of narrow ones no longer leaves 24 of the 25 unspent. It used to be one
route per tick, and §8 is what that broke.

**A tick that runs out is paused, not truncated.** `runSearchPass` returns
`paused` with the remaining work still in the plan; the `runs` row keeps
`status = 'running'` and `finished_at` NULL, and the next tick calls
`selectResumableAlertRun` and resumes from `tasks_ok + tasks_failed` — a bare
integer index into a **chunk-major** task list. That ordering is load-bearing:
reordering tasks between passes would make a resumed sweep silently re-run some
and skip others. It is the same `run_continue` mechanism the interactive search
uses; nothing here is a second implementation.

A paused route also files nothing (§6): half a route's window described as
though it were the whole answer is worse than a delayed digest.

---

## 3. What one tick does, in order

`api/src/features/alerts/tick.ts`, and the order is the design.

1. **Identity.** `APP_USER_EMAIL` unset → `no_app_user_email`, return.
2. **Load the alert routes.** `selectAlertRoutes` returns every route with
   `alerts_enabled = 1`, joined to what its own last completed sweep actually
   spent (`runs.calls`, matched **by `route_id`** — the `origin`/`destination`
   scalars are only a route's primary airports, so two routes sharing a pair
   would otherwise be priced off each other's measurements). None → return.
3. **Price the cycle** (§4). Unaffordable → report the reason and return,
   without sweeping. Sweeping anyway would spend the reserve a manual search
   depends on.
4. **Pick the due routes**, most overdue first, so a tick that runs out of calls
   part-way starves the route that has waited least rather than an arbitrary
   one.
5. **For each target, while calls remain:**
   - Re-read the budget state, **per route rather than once per tick**:
     `finishRun` has written the previous route's `calls` by now, so
     self-accounting stays honest as the tick spends and the reserve is measured
     against what is actually left.
   - `decideSweep` (§7). Refused → record a `skipped` entry and move on. **No
     `runs` row is written for a refused sweep** — `runs.status` has a CHECK
     constraint with no `'skipped'` in it, and a row that spent nothing would
     pollute the pacing measurements it feeds. `exhausted` breaks the loop
     (it is an answer about the day, not this route); `reserve` continues, since
     a cheaper route later in the list may still fit.
   - Sweep it, and subtract what it actually spent.
6. **Flush, if the cycle is complete** (§8), and prune old runs (§12).

`sweepRoute` itself, in order: stamp the pacing clock **before anything can
fail** → resume or plan → open the run → run the pass → on total failure bump
the failure counter, otherwise clear it → if paused, stop → if this is the
route's baseline, stamp the digest clock and file nothing (§5) → otherwise
select what is alertable and file it into the outbox.

It returns the calls it actually spent. A route that never reached
`runSearchPass` — a refused plan, a run that would not open — spent nothing and
is reported as nothing, so a tick is not shortened by a route that failed for
free.

---

## 4. Pacing: one cost model, two readers

`api/src/features/alerts/pace.ts`. Pure, and that is what makes the rest of this
section enforceable.

The model is one sentence: **a Pro key buys 1000 seats.aero calls per UTC day, a
reserve is held back so a person pressing Search is never refused, and whatever
is left is divided among the alert-enabled routes.** More routes, or wider ones,
means each is swept less often.

```
cycleCost   = Σ routeSweepCost(route)                  over searchable routes
cyclesPerDay = floor(dailyBudget / cycleCost)
interval    = clamp(ceil(1440 / cyclesPerDay), 30, 1440)   minutes
```

**The cost unit is the TASK — one (chunk, query) pair — not the chunk.** A route
with hubs plans two queries per date chunk, because `SFO→ICN` and `ICN→KTM` are
different markets and a cross product rides in one call but two markets cannot.
Counting chunks would budget a hub route at half what it spends.

**Pessimistic while ignorant, measured once measured.** `estimateSearchCalls`
quotes a range a factor of ten wide — one call per task at the floor, ten if
every task paginates out — so a route that has never been swept is priced at
`tasks × SEATSAERO_MAX_PAGES`, and a route that has is priced at
`max(observedCalls, tasks)`. The `max` is there because a paused sweep records
only what *that pass* spent, and a route resumed across three ticks would
otherwise look a third as expensive as it is. Guessing low overspends the day;
guessing high sweeps less often than it could — and only one of those is
recoverable.

**Unaffordable is a return value, not a clamp.** When one cycle costs more than
a day's allowance, `floor(budget / cost)` is 0 and dividing by it yields
Infinity, which would clamp silently to the daily maximum and present a route
that *cannot* be afforded as one that is merely slow. You would then wait a day
for an email that was never going to arrive. `sweepPacing` returns
`{ affordable: false, reason }` instead, and the Alerts tab renders it as an
error with the three things that would fix it.

**A zero-chunk route is excluded from both the cost model and the due set.** Its
window has fallen entirely into the past; every sweep would refuse at
`planSearchPass` before spending anything. Counting it as free would let it drag
down the cadence of the routes that do work, so it is surfaced by name
(`windowExpired`) instead.

**A route is due on the tick NEAREST its due time, not the first tick strictly
after it.** `dueGraceMs` allows half a tick of grace, and it is a fix for
something measured rather than a hypothetical: four routes the Alerts tab paced
at `every 15m` were swept every 30 minutes, exactly, for as long as `runs`
recorded. The hair is the sweeper's own write — `alert_last_attempt_at` is
stamped with the tick's clock, but `last_checked_at`, which `routeDueAt` takes
as a floor, is written when the search *finishes*, 1.3 to 4.6 seconds later, and
the cron is regular to the millisecond. `lastChecked + interval` therefore
landed just *after* the next tick every single time.

### The rule that makes this a module rather than a function

**`GET /api/alerts/schedule` calls the same pure functions the scheduler calls
— `sweepPacing`, `dueRoutes`, `routeSweepCost`, `decideSweep` — and the SPA
re-derives none of it.** `due`, `windowExpired`, `intervalMinutes` and
`estimatedCalls` all arrive already decided.

A second implementation would produce a page quoting a cadence the scheduler
does not keep, and **a wrong number you trust is worse than no number**. That is
why `alertRoutes.ts` exists at all: it is the projection both surfaces read. It
is also why `POST /api/alerts/run` calls `runAlertTick` rather than
reimplementing a tick — there is then nothing it can exercise that production
does not do.

---

## 5. The baseline sweep, and why the first one is silent

**A route's first sweep files nothing.** This is the single most important line
in `sweepRoute`.

`diffAvailability` compares a sweep's results against the stored snapshot for
that slot. A route nobody has searched recently has no useful snapshot, so it
classifies everything it finds as `new` plus a wall of `gone` — thousands of
changes, truncated at `MAX_STORED_CHANGES` (200), rendered as a meaningless
"200 changes" digest that trains you to ignore the mail.

So a route whose `alert_last_digest_at` is NULL ingests normally, files nothing,
and stamps the clock. The next sweep has a real baseline to diff against. The
same rule covers a route whose alerts were switched off and back on.

**Turning alerts on does not always cost a baseline.** `baselineOnEnable` sets
the digest clock to `now` — arming the route immediately — when
`last_checked_at` is fresher than `MAX_SWEEP_MINUTES`. The question is not "has
the scheduler swept this" but "is there a recent enough snapshot to diff
against", and a route somebody searched by hand ten minutes ago has one. The
cutoff is `MAX_SWEEP_MINUTES` because that is the slowest cadence the pacer will
ever claim: data that fresh is no staler than what a normal cycle diffs against,
so accepting it grants nothing the scheduler does not already do to itself.

**Known edge, deliberately not handled.** `last_checked_at` is one timestamp for
the whole route, so a search that covered part of the window looks as fresh as
one that covered all of it. Widening a window and enabling alerts in the same
breath can still produce one noisy digest. Bounding it properly means recording
per-slice check times — a whole stored table for one avoidable email.

The SPA says `awaitingBaseline` on the route so that "I turned it on and got
nothing" does not read as a fault.

---

## 6. What gets alerted on

`api/src/features/alerts/select.ts`.

`diffAvailability` classifies four transitions. A route's `alert_on` chooses
among them; NULL means the default set.

| type | in the default set | why |
| --- | --- | --- |
| `new` | yes | award space that was not there before — the reason you are watching |
| `price_drop` | yes | subject to `alert_min_drop_pct` |
| `more_seats` | no | a seat count rising on space you already knew about is rarely why you are watching |
| `gone` | no | mostly cache churn and dates ageing off the front of the window, and it honours fewer of the route's filters than the others (below) |

`alert_min_drop_pct` defaults to **5**, not 0: seats.aero re-quotes constantly
and a 1% movement is noise.

**`alert_on: []` is a 400, not a stored value.** Every other JSON list column on
`tracked_routes` treats `[]` as "no filter, everything matches"; here it would
mean the opposite — a route that looks armed and is silent forever, which is the
single most plausible way for this feature to appear broken while behaving
exactly as configured. NULL is the only way to say "default". Reading an empty
or unrecognisable array back out is therefore evidence of corruption, and
`parseAlertTypes` treats it as the default rather than as a request for silence.

**A change must also be one the route's own pane would show.** After the sweep,
`routeFindKeys` reads the route's current finds and runs
`shared/src/match/routeMatch.ts` — the *same* predicate the Routes page runs —
and `selectAlertable` intersects the changes against that key set. An alert that
fires on a find the route's pane hides is indistinguishable from a bug in either
half, and since no mail is sent when nothing is found, the other direction
reports itself to nobody.

**`gone` bypasses the intersection, and must.** The whole point of `gone` is
that the row is no longer there, so it can never appear in a query of current
finds; intersecting it would silently drop every disappearance. It is filtered
on what the change summary itself carries — cabin, previous seats, and previous
price against the route's ceiling — which means the route's currency and
nonstop filters do not apply to it. One more reason it is opt-in. An unknown
previous price passes rather than being dropped.

Changes are de-duplicated by key before filing: one sweep can apply several
chunks and a resumed sweep several passes, so the same key legitimately arrives
twice. The outbox is unique on it anyway; de-duplicating here is what keeps the
digest's own counts honest.

---

## 7. The budget guard

`api/src/features/alerts/scheduler-budget.ts`. Pure decision, thin read.

Three numbers, and they are not the same number:

| | default | what it bounds |
| --- | --- | --- |
| the key's own allowance | 1000/day, UTC | seats.aero's, not ours. `ASSUMED_DAILY_LIMIT` when nothing has reported one |
| `ALERT_DAILY_BUDGET` | 600 | what **automation** may spend in a day |
| `ALERT_MANUAL_RESERVE` | 300 | what must remain unspent so a **person** pressing Search always gets an answer |

`decideSweep` refuses in three ways:

- `exhausted` — nothing left at all. Breaks the tick's loop.
- `reserve` — the sweep would leave less than the reserve. Note it compares
  against what would remain *after* the sweep, which is the whole point.
- `reserve` again — the scheduler's own daily allowance would be exceeded, even
  on a day the key's ceiling is nowhere near. Same code, different ceiling.

**`basis` is `observed` or `self_accounted`, and it is worth showing.**
seats.aero's `X-RateLimit-Limit`/`Remaining` headers are recorded into
`source_quota`, keyed `(source, UTC day)` — so a row from yesterday is simply
not selected and an exhausted count cannot leak across the reset. Early in a UTC
day nothing has reported a number yet, and the guard reasons from
`SUM(runs.calls)` since 00:00 UTC instead. Both are approximations of different
things and the Alerts tab names which one is in force.

The whole read is one `db.batch` of two statements (`selectBudgetRows`), covered
by `idx_runs_spend` so the SUM does not touch the table.

**`opts.force` bypasses cadence and nothing else** (§9). Pacing answers "how
often"; the guard answers "can this be paid for". They are different questions
and only one of them is a development inconvenience.

---

## 8. The outbox, and when a digest goes out

`api/src/features/alerts/outbox.ts`.

The product rule is **one digest per sweep cycle** — a cycle being one full pass
over every alert route. A tick may not get through a cycle (§2). Those two
coexist only if a change outlives the tick that found it, which is what
`alert_outbox` is: alertable changes, keyed `(route_id, change_key)`,
`WITHOUT ROWID` so filing one costs one row written. Newest wins on conflict —
a route swept twice before a flush must not report the same seat twice, and the
later observation is the true one. It is scoped by `route_id` because two routes
can legitimately watch the same pair with different filters and different
recipients.

A tick that dies therefore loses nothing.

`cycleComplete` is the flush condition: **no route due, and no run still
`running`.** That is when a full pass is over.

This is also the piece that broke when a tick swept exactly one route. Four
routes paced at 15 minutes left three of them permanently due, so
`cycleComplete` never once returned true and no digest was ever sent. Sweeping
to a call cap instead (§2) is what lets a narrow set finish its cycle inside one
tick and flush at all. The outbox is still required, because a set wider than
`ALERT_MAX_CALLS_PER_TICK`, or one route that pauses, still spans ticks.

`flushOutbox` then:

1. Reads everything waiting, joined to the route that filed it. *The column
   aliases in that query are load-bearing* — `o.*` already yields `origin` and
   `destination` (the **change's**), SQLite keeps the last column of a repeated
   name, and selecting `tr.origin` unaliased once overwrote them with the
   route's primary pair, making every line of every digest name the wrong city
   pair on any multi-airport, hub or round-trip route.
2. Adds the **quiet** routes — swept, past baseline, nothing filed — by name.
   "Three checked, two quiet" and "only one ran" are different facts, and with
   no failure email there is nothing else to tell them apart.
3. Groups **by recipient, not by route**: one person watching three routes gets
   one email with three sections. A recipient whose routes were *all* quiet gets
   nothing — there is no news, and this app does not send "still working" mail.
4. Sends, records an `alert_deliveries` row for every outcome, and **only on a
   successful send** clears that recipient's outbox rows and stamps their digest
   clocks. A refused send leaves the outbox intact so the next cycle tries again
   rather than losing it.

The digest renderer (`digest.ts`) is pure and is the whole of what the tests
assert on; the Worker half only hands its strings to Resend. Everything that
reaches it came out of somebody else's payload, so it is HTML-escaped —
injecting your own inbox is still a bug.

Step 4 has a tail worth knowing: a route pointed at an address that is no longer
allowed records `skipped: recipient_not_allowed`, keeps its outbox rows, and
retries the same refusal every cycle forever, announcing it to nobody. That is
why §9 refuses the delete that would create it.

---

## 9. Sending: who, how, and the one manual control

### Who

`alert_recipients` is a table, edited from the settings dialog's **System** tab.
It was an env binding, which meant a deploy per edit.

`APP_USER_EMAIL` is **always allowed and is never a row**, so an empty table
still means "only the account's own address" — the safe default rather than the
permissive one, and never "this deployment can email nobody". It sorts first
because it is the answer to "who gets this by default": a route with a NULL
`alert_email` resolves to it.

The list exists because with one shared password as the only auth, an unchecked
`alert_email` would make this Worker an arbitrary-recipient sender on a verified
domain, and the domain's sending reputation is not something a typo should be
able to spend.

**It is enforced twice, deliberately.** `validateAlerts` stops a bad address
being *stored*; `sendEmail` re-checks at *send* time, which is what catches an
address that was allowed when the route was saved and has since been removed.
`DELETE /api/settings/recipients/:id` closes the third door by refusing while a
route still points there (§1, §8).

### How

Resend, `POST https://api.resend.com/emails`. **This is the Worker's second
outbound host and the distinction is what makes it allowed**: it is not a data
source but a delivery channel, and a keyed vendor API on exactly the same
footing as seats.aero — it authenticates the key, not the client. Nothing about
the airline prohibition in `CLAUDE.md` changes.

Double sends are guarded twice: a `sweep_id` uuid minted per flush plus
`PRIMARY KEY (sweep_id, to_email)` on `alert_deliveries` on our side, and a
matching `Idempotency-Key` header (SHA-256 of `sweepId:recipient`, which Resend
honours for 24h) on theirs.

`alert_deliveries.status` is three-valued and the third value is the interesting
one:

- `sent` — the provider accepted it; `provider_message_id` is theirs.
- `failed` — we tried and were refused; `error` carries the provider's own body,
  because an unverified sending domain reads very differently from a bad key.
- `skipped` — we never tried: no `RESEND_API_KEY`, no `ALERT_FROM`, or the
  recipient is not allowed. **One is our configuration and the other is theirs,
  and they are fixed in different places**, so they must not read the same.

A missing key does not stop a sweep. It still runs, still ingests, and records
why nothing arrived — the same posture as `no_seats_aero_key`: an absence must
never look like an empty result.

### The manual control

`POST /api/alerts/run` fires one tick by hand. **Local dev only** — it answers
404 off a loopback host, so in production it is indistinguishable from a route
that was never written. It sits behind `gate` regardless; the host check decides
what a developer can reach, not who is let in.

It exists because otherwise working on `alerts/` means waiting up to thirty
minutes for a tick, up to `intervalMinutes` for that tick to choose your route,
and then reading D1 by hand to find out what it decided.

Three properties, each load-bearing:

- **It is `runAlertTick`, not a copy of it.**
- **It returns the whole `TickResult`.** A tick that swept nothing must say why,
  or this becomes one more surface where broken and quiet look identical.
- **`routeId` bypasses cadence, never the budget guard.**

A forced sweep still stamps `alert_last_attempt_at`, so it does move the route's
clock. That is correct: it really did spend the calls. It also still refuses a
route whose window has expired, rather than letting it reach `planSearchPass`
and bump the failure counter for a fault that is not the sweeper's.

The Alerts tab learns whether the button exists from `manualTick` in the
schedule payload, rather than probing for a 404 — a button that appears only to
fail is worse than no button.

---

## 10. The three clocks, and the back-off

`tracked_routes` carries three timestamps for this feature. **Collapsing any two
re-creates a bug the others exist to prevent.**

| column | written | read as |
| --- | --- | --- |
| `last_checked_at` | when a run **claims coverage** | a **floor** — a route a person searched by hand two minutes ago is not swept again immediately |
| `alert_last_attempt_at` | on **every** sweep attempt, before anything can fail | the **pacing clock** |
| `alert_last_digest_at` | when a digest covering the route is **sent**, or on its silent baseline | the **email clock** — NULL means the next sweep is a baseline (§5) |

The pacing clock cannot be `last_checked_at`, and this is the trap worth naming:
`last_checked_at` is never written when a run fails, so a permanently-failing
route would be due on *every single tick* and would spend the entire day's
allowance rediscovering the same failure.

`routeDueAt` takes the max of both: `attempt + interval × backoff` and
`checked + interval`.

**Back-off is on the attempt clock only.** `alert_consecutive_failures` is
bumped when a pass returns zero successful tasks and cleared when one succeeds,
and the wait is `interval × 2^min(failures, 3)` — capped, because eight failed
sweeps in a row is a route that needs a person, not a faster retry. Without it,
the likeliest real fault — a date window that slipped into the past just by time
passing — takes a slot in every cycle forever.

The SPA collapses all of this into one first-match-wins ladder in
`app/src/lib/alerts.ts`: `expired` → `failing` → `baseline` → `due` →
`watching`. A failing route whose window has *also* expired reports as
`expired`, because that is the one you can actually fix.

---

## 11. Configuration, surfaces, and where the code is

### Environment

All optional; all documented on the field in `api/src/bindings.ts`.

| binding | default | unset |
| --- | --- | --- |
| `APP_USER_EMAIL` | — | the tick returns `no_app_user_email` and spends nothing (§1) |
| `RESEND_API_KEY` | — | sweeps run, digests recorded `skipped` |
| `ALERT_FROM` | — | same as a missing key |
| `ALERT_DAILY_BUDGET` | 600 | — |
| `ALERT_MANUAL_RESERVE` | 300 | — |
| `ALERT_MAX_CALLS_PER_TICK` | 25 | — |
| `APP_URL` | — | the digest omits its link back into the app |

### Endpoints

| | |
| --- | --- |
| `GET /api/alerts/schedule` | everything the Alerts tab renders — pacing, budget, email config, and 14 fields per route |
| `GET /api/alerts/runs` | recent sweeps; `runs` filtered to `trigger = 'alert'` |
| `GET /api/alerts/deliveries` | every digest attempted, including the ones that never went out |
| `POST /api/alerts/run` | one tick by hand; 404 off loopback (§9) |
| `GET`/`POST`/`DELETE /api/settings/recipients[/:id]` | the allowlist |

A route's own alert settings are **not** here: they are fields on
`PATCH /api/tracked-routes/:id`, because they are properties of the route.

Both list endpoints clamp `?limit=` at **both** ends. `Math.min(n, 100)` alone
let `?limit=-1` through, and SQLite reads `LIMIT -1` as *no limit* — on
`SELECT *` over tables that grow with every sweep, billed by rows read.

### Files

| | |
| --- | --- |
| `tick.ts` | what a tick **decides**. The only impure orchestrator here |
| `pace.ts` | cadence and due-ness. Pure (§4) |
| `scheduler-budget.ts` | `decideSweep` pure, `readBudgetState` the one pre-spend quota read (§7) |
| `select.ts` | which changes are worth an email. Pure (§6) |
| `alertRoutes.ts` | the projection both the scheduler and the tab read |
| `outbox.ts` | when a digest goes out, and the run prune (§8, §12) |
| `digest.ts` | what it **says**. Pure (§8) |
| `email.ts` | Resend transport |
| `recipients.ts` | who may be written to — policy, split from transport |
| `../endpoints/alerts-endpoints.ts` | the tab’s reads and the manual tick |
| `../endpoints/settings-endpoints.ts` | the allowlist’s CRUD |

Tests are `*.test.ts` beside each; the pure four (`pace`, `budget`, `select`,
`digest`) carry the interesting reasoning, and `tick.test.ts` covers the
orchestration. `npm test` runs them offline.

### Cross-slice edges

`alerts/` imports `features/search/run.ts` — the engine it re-runs.
`features/trackedRoutes/` imports `alerts/recipients.ts` (the allowlist),
`alerts/select.ts` (the types) and `alerts/pace.ts` (`baselineOnEnable`). Those
are public surfaces two features must not fork. Neither slice imports an
endpoint module: `api/src/endpoints/` is the top of the graph and nothing below
it imports upward.

---

## 12. Retention

**`runs` is the only table in this app that grows on a clock rather than with
the data**, at roughly 50 rows a day, so it is the only one pruned.
`pruneOldRuns` deletes rows older than 30 days, **once per completed cycle** —
not per tick — bounding the table at about 1,500 rows.

Thirty days is generous to every reader: the Alerts tab shows 25, the pacing
lookup wants the most recent one per route, and the budget guard only ever asks
about today. Every read of the table gets cheaper for it.

Two details:

- **A run still `running` is spared whatever its age.** That is a paused sweep
  waiting to resume (§2), and deleting it would strand the route that owns it.
- **The delete is deliberately unbounded by a LIMIT.** At ~50 rows a day the
  steady-state delete is a handful, and a first run after a long gap should get
  it over with rather than leave a backlog that never drains.

Nothing else is pruned, and each is bounded by something other than time:
`alert_outbox` empties on every successful flush and cascades on route delete;
`alert_deliveries` grows by a few rows per cycle and is the permanent audit
trail §1 depends on; `source_quota` is one row per source per day.
