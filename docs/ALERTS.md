# Alerts

The scheduled sweep: `workers/api/src/alerts/` (the impure half — the cron tick,
the budget guard, the read API), `packages/core/src/alerts/` (the pure half —
pacing, selection, the digest), `workers/api/src/email.ts` (Resend), and the
Alerts tab that reports on all of it.

This is **the only unattended work in the repo**, and it reverses four rules that
were written down deliberately. §1 is the argument for that; read it before
changing anything here.

---

## 1. Why this exists, against four comments that forbade it

| where | what it said |
|---|---|
| `workers/api/wrangler.toml` | "Nothing is scheduled: no [triggers], no cron. Adding one would recreate unattended work, and unattended work hides source failures." |
| `workers/api/src/search.ts` | "nothing runs on a schedule… No cron, no queue, no budget guard." |
| `docs/SEATS-AERO.md` §1 | "A source the server can call is exactly what makes a cron look tempting, and it is still forbidden." |
| `migrations/0001_init.sql` (`source_quota`) | "THIS IS NOT A BUDGET GUARD… if you ever find code gating a call on this value, that is the guard coming back and it needs the argument in CLAUDE.md to survive first." |

Those were right for the app that existed when they were written, and each names
a real risk. All four have since been rewritten in place — this table is what
they *said*, kept because the argument below only makes sense against it. The
`source_quota` note in particular asked for an argument before any code gated a
call on it; "The budget guard is gone" below is that argument and §7 is its
implementation, and the note now names `alerts/budget.ts` as the one reader
allowed to.

Two objections, two answers.

### "Unattended work hides source failures."

It does. This app makes it worse before it makes it better, because **no email is
ever sent about a failed sweep** — only about finds. A scheduler that has been
blocked all week therefore produces exactly the same silence as one that ran and
found nothing, and that is the confusion the whole architecture exists to
prevent ("no key" must never look like "no award space").

So the failure has to be visible somewhere that is not the inbox:

- **Every sweep is an ordinary `search_runs` row** (`trigger = 'alert'`), with
  its tasks, captures, timings and errors — the same record a manual search
  leaves, through the same ingest pipeline.
- **The Alerts tab is ordered problems-first**: unconfigured email, an
  unaffordable route set, a budget block, failing routes, expired windows, and
  undelivered digests all render above the cadence.
- **The tab strip carries a dot** when any of that is true, so a broken
  scheduler is noticeable without opening a tab you have no reason to open.
- **`alert_deliveries` records every send attempt**, including the ones that
  never happened. `skipped` (our configuration) and `failed` (theirs) are
  distinct, because they are fixed in different places.

If you add a code path where a sweep can fail without landing on that page, you
have re-introduced exactly what the comment warned about.

### "The budget guard is gone."

It was deleted **because unattended work was deleted**. A person pressing Search
does not need protecting from a call they chose to spend, and a guard there turns
a deliberate action into a baffling refusal. Both halves are still true:
`search.ts` and `enrich.ts` still spend first and report after, and
`docs/SEATS-AERO.md` §9's "quota is a display" holds for **every path a human
drives**.

What changed is that a process now spends without being watched, which is what a
budget is for. So the guard is back, in exactly one file
(`workers/api/src/alerts/budget.ts`) so that "who consults quota before spending"
stays a one-file answer to `grep`. Nothing else may import it.

And note what it actually protects: not the quota for its own sake, but the
**reserve** — the scheduler stops well short of the ceiling so a human pressing
Search at 9pm gets an answer instead of a 429 a robot caused.

---

## 2. The shape of one tick

```
cron  */15 * * * *        (30s CPU — see §3)
  │
  ▼
scheduled()  →  every alert route + its clocks + its measured cost
  │           (POST /api/alerts/run enters here too — dev only, §9)
  │
  ├─ sweepPacing()   → interval, or {affordable: false}   ─┐ cadence: a forced
  ├─ dueRoutes()     → most overdue first                 ─┘ sweep skips both
  ├─ decideSweep()   → the budget guard  ← never skipped, by anything
  ▼
sweep ONE route  →  planSearchPass → openSearchRun → runSearchPass
  │                                                      │ changes[]
  │                                                      ▼
  │                                          intersect with findsCte
  │                                          (the route's own filter SQL)
  │                                                      ▼
  │                                              selectAlertable()
  │                                                      ▼
  │                                                 alert_outbox
  ▼
flush?  nothing due AND nothing mid-run
  ▼
groupForRecipients → renderDigest → Resend → alert_deliveries
```

---

## 3. Why one route per tick, and why an outbox

**A Cron Trigger with an interval under one hour gets 30 SECONDS of CPU.** An
hourly one gets 15 minutes. That is a platform limit, not a tunable, and it is
the single fact that shapes this design.

Waiting on seats.aero is I/O and costs no CPU. *Parsing* does: a page is up to
500 rows carrying trips, measured at ~9.9 KB each (`docs/SEATS-AERO.md` §3), and
a chunk can take ten pages. So a tick sweeps **one** route, capped at
`ALERT_MAX_CALLS_PER_TICK` (25), and a route needing more resumes on the next
tick through the **same `run_continue` / `?from=` mechanism the HTTP search
uses**. That protocol already existed for the same class of problem; it is reused
rather than reinvented.

Subrequests are *not* the constraint — the Paid plan allows 10,000 per
invocation, and although D1 binding calls do count toward it, `applyTask`'s few
hundred round trips per route are nowhere near.

**Hence the outbox.** The product rule is one digest per sweep *cycle*, grouped
by route; the platform rule is one route per tick. Those only coexist if a change
outlives the tick that found it. Alertable changes land in `alert_outbox` and the
digest flushes when the cycle completes — nothing due, nothing mid-run. A tick
that dies loses nothing, and a **paused route files nothing**, so a digest never
describes half a route as though it were the whole answer.

---

## 4. Pacing

`packages/core/src/alerts/pace.ts`. Pure, and the Alerts tab calls the **same**
function the scheduler does — a page that quoted a cadence the scheduler does not
keep would be worse than no page, because you would trust it.

```
costPerRoute = observed ? max(lastObservedCalls, chunks) : chunks * MAX_PAGES
cycleCost    = Σ costPerRoute
cyclesPerDay = floor(dailyBudget / cycleCost)
interval     = clamp(ceil(1440 / cyclesPerDay), 15, 1440) * 2**consecutiveFailures
```

Four things here are deliberate:

- **Pessimistic while ignorant.** A never-swept route is priced at the
  **ceiling** (chunks × 10), not the floor. `estimateSearchCalls` quotes a range
  whose ends are a factor of ten apart, and guessing low is the direction that
  overspends.
- **`max(observed, chunks)`.** A paused sweep records only the calls *that pass*
  spent, so a route resumed across three ticks would otherwise look a third as
  expensive as it is.
- **Unaffordable is a return value, not a clamp.** `floor(budget/cost)` is 0 the
  moment one cycle exceeds a day's allowance, and `1440/0` is `Infinity` — which
  would clamp silently to "once a day" and present a route set that can never be
  swept as merely slow. It returns `{affordable: false, reason}` and the tab says
  so.
- **A zero-chunk route is excluded from the cost model and from the due set.**
  Its window has fallen entirely into the past; it would refuse at planning and
  burn a tick to learn what the plan already knows.

### Three clocks

Collapsing any two re-creates a bug the others prevent.

| column | job |
|---|---|
| `last_checked_at` (pre-existing) | "this route holds real data as of…" — written only by a run that claimed coverage. Consulted as a **floor**, so a route searched by hand five minutes ago is not re-swept. |
| `alert_last_attempt_at` | the **pacing** clock — written on every attempt, success or failure. Pacing off `last_checked_at` alone would hot-loop a failing route: that column is never written when a run fails, so the route would be due on every tick forever. |
| `alert_last_digest_at` | the **email** clock — and what makes the first sweep silent (§5). |

`alert_consecutive_failures` backs the interval off by `2^n`, capped, so a route
whose window quietly expired costs one sweep a day rather than one every tick.

---

## 5. The first sweep of a route sends nothing

`diffAvailability` compares against the last snapshot **for that source**. A
route that has not been searched recently therefore classifies everything it
finds as `new`, plus a wall of `gone` — thousands of changes, truncated to
`MAX_STORED_CHANGES`, emailed as a meaningless 200-of-3000 digest.

So a route with `alert_last_digest_at IS NULL` performs a **baseline sweep**: it
ingests normally, files nothing, and stamps the clock. The Alerts tab shows it as
`baseline pending` so "I turned it on and got nothing" does not read as a fault.

### Enabling alerts on a route that was just searched

**The baseline is the stored snapshot; `alert_last_digest_at` is only the
suppression.** A route somebody searched by hand ten minutes ago already holds
the snapshot a baseline sweep would go and fetch, so suppressing there spends the
route's full call cost to compute a diff against fresh data and throw the answer
away — and then makes you wait another whole interval for the first email.

So `PATCH` does not blindly clear the clock on 0 → 1. `baselineOnEnable`
(`packages/core/src/alerts/pace.ts`) stamps it with `now` when
`last_checked_at` is within `MAX_SWEEP_MINUTES`, and `NULL` otherwise. That
cutoff is the slowest cadence the pacer will ever claim, so anything accepted is
no staler than what a routine sweep diffs against; older than that and the
wall-of-`new` above is real again. A route that has never been searched, or that
went dark months ago, still gets its silent baseline.

One edge is knowingly unhandled: `last_checked_at` is a single timestamp for the
whole route, so a search that covered only part of the window looks as fresh as
one that covered all of it. Widening a window and enabling alerts in the same
breath can still produce one noisy digest. Bounding that properly means
comparing `search_coverage` against the planned chunks — a lot of machinery for
one avoidable email.

---

## 6. What counts as alertable

`ChangeType` was already the right vocabulary — `new | more_seats | price_drop |
gone` — and `diff.ts`'s own docblock says it emits "only meaningful,
**alert-worthy** transitions". The diff was designed for this.

**The route's filters are applied in SQL, not in TypeScript.** After a sweep, one
`findsCte` query scoped to the route's pairs and window, filtered by
`ROUTE_FINDS_MATCH` — *the same fragment the dashboard's join uses* — yields the
set of keys that survive the route's cabins / currencies / min-seats /
nonstop rules. `selectAlertable` keeps only changes whose key is in that set.

That is not tidiness. "Can the couple book this?" already exists twice
(`bookableCurrencies` in core, `BOOKABLE_WITH_CLAUSE` in the Worker) and
`CLAUDE.md` warns the two must be kept in step. A third copy in TypeScript would
be the only one blind to the cross-source collapse and the `cash_any`
carry-forward — so it could fire on a snapshot another source has already
superseded, i.e. email you about a seat the app itself does not show.

Two consequences worth knowing:

- **`gone` bypasses the intersection**, and must: there is no current row left to
  match, so intersecting would silently drop every disappearance. It is filtered
  on what the summary carries (`cabin`, `previousSeats`), which means
  `direct_only` and `currencies` do not apply to it. That, plus cache churn, is
  why `gone` is **not** in the default set.
- **Classification is first-match-wins** (`diff.ts`): seats are checked before
  price, so a drop that coincides with a seat increase is reported as
  `more_seats` only. A route watching `price_drop` and not `more_seats` never
  hears about it. This is documented in the route form's help text and pinned by
  a test rather than fixed — changing the classifier would change
  `changes_json` for the hand-pressed searches too. The digest mentions the price anyway.

`alert_on = []` is **refused with a 400**. Every neighbouring list column
(`cabins`, `currencies`) treats `[]` as "no filter, everything matches"; here it
would mean the opposite — armed and permanently silent — which is the single most
plausible way for this feature to look broken while behaving exactly as
configured. `NULL` is the only way to say "the default set".

---

## 7. The budget guard

`workers/api/src/alerts/budget.ts`. Pure `decideSweep`, so the reasoning is
testable without a D1.

The **absent-observation** case is the one that matters. `source_quota` is
written only when a call is actually made, so on most days — days nobody manually
searched — there is no row at all when the first tick fires. Both obvious answers
are wrong:

- *Refuse until something is observed.* The scheduler would never fire on any day
  it was the only thing running, which is nearly all of them. The feature dies
  silently — precisely the failure §1 is about.
- *Assume a full 1000.* Optimistic in the one direction that overspends, on the
  one day it mattered.

So it **self-accounts**: last known limit minus `SUM(search_runs.calls)` for
runs started since 00:00 UTC. That is an honest number from our own records, and
it is why `search_runs.calls` exists at all. The first real
`X-RateLimit-Remaining` of the day corrects it.

A row from a previous UTC day is never selected — `source_quota`'s key is
`(source, day)` — so yesterday's exhausted count cannot be mistaken for today's.

The reserve compares against what would be left **after** the sweep.

---

## 8. Configuration

Secrets (`wrangler secret put`, or a line in `workers/api/.dev.vars` locally):

| | |
|---|---|
| `RESEND_API_KEY` | Unset ⇒ sweeps still run and still ingest, but each digest is recorded `skipped` with `no_resend_api_key`. Never a silent drop. |

Vars (`[vars]` in `wrangler.toml`):

| | default | |
|---|---|---|
| `ALERT_FROM` | — | On a Resend-**verified** domain. Unset behaves like a missing key. |
| `ALERT_ALLOWED_RECIPIENTS` | — | CSV. `APP_USER_EMAIL` is always included, so unset means "only the account's own address" — the safe default, not the permissive one. With one shared password as the only auth, an unchecked per-route `alert_email` would make this an arbitrary-recipient sender on a verified domain. |
| `ALERT_DAILY_BUDGET` | 600 | Calls a day **automation** may spend. |
| `ALERT_MANUAL_RESERVE` | 300 | Calls that must stay unspent so a manual Search always works. |
| `ALERT_MAX_CALLS_PER_TICK` | 25 | Per-tick ceiling; see §3. |
| `APP_URL` | — | Base for the digest's link back. |

**Deploy prerequisite:** the sending domain needs SPF/DKIM records added in
Resend. That is DNS, not code, and until it is done every send fails with the
provider's own message in `alert_deliveries.error`.

---

## 9. Testing it

The repo has no D1 or Worker test harness, so the logic lives in pure functions
and is tested there — `packages/core/src/alerts/*.test.ts` and
`workers/api/src/alerts/budget.test.ts` (following the `gate.test.ts` precedent
of testing only pure exported functions).

Everything else needs a running tick, and `wrangler dev` **never** runs crons on
their real schedule.

### The Alerts tab's dev controls

`POST /api/alerts/run` fires one tick and answers with the whole `TickResult`. It
**404s unless the Worker is answering on a loopback host** (`isLocalRequest` in
`workers/api/src/security.ts`) — in production the route should be
indistinguishable from one that was never written. `GET /api/alerts/schedule`
reports `manualTick` off the same predicate, which is what makes the buttons on
the Alerts tab appear at all.

- **Run tick** — no body. Exactly what the cron does, cadence included; on a
  normal day that means sweeping nothing, and the result panel says so.
- **Sweep**, per route — `{ "routeId": N }`. Sweeps that route whether or not it
  is due.

```sh
curl -X POST http://127.0.0.1:8787/api/alerts/run -H 'content-type: application/json' -d '{"routeId":3}'
```

**`routeId` bypasses cadence and nothing else.** It skips the due filter and the
unaffordable-pacing return, because waiting four hours to find out whether a code
change works is the entire reason the endpoint exists. `decideSweep` still runs,
in the same place, unchanged — a forced sweep gets refused for `reserve` or
`exhausted` like any other, and that refusal arriving in `skipped` is the cheapest
proof the guard was not routed around. A forced sweep also stamps
`alert_last_attempt_at`, so it moves the route's clock; it really did spend the
calls. A route whose window has expired refuses in `runAlertTick` rather than at
`planSearchPass`, so forcing one cannot inflate `alert_consecutive_failures`.

The route is a wrapper over `runAlertTick` and not a second implementation of a
tick, which is the only thing that makes testing through it meaningful.

### Without the SPA

`npm run dev:api` also passes `--test-scheduled`, which exposes wrangler's own
shim. It takes no arguments and returns no body, so prefer the endpoint above
unless you are specifically testing `scheduled()` itself:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"
```

Two things to know when it appears to do nothing:

- With `run_worker_first = true`, confirm `/__scheduled` is not being answered by
  the SPA. (It is not, as of this writing — but the failure mode is a 200 full of
  `index.html` that looks like a working cron.)
- A tick with nothing due sweeps nothing, on purpose. Check
  `GET /api/alerts/schedule` for `due` and `wouldSweepNow`.

To exercise the digest without spending a metered call: stamp a route's clocks so
nothing is due, insert a row into `alert_outbox` by hand, and fire a tick — the
flush path runs on its own.

In production, `wrangler tail bertbooker` shows scheduled invocations, and the
Cloudflare dashboard has a Cron Triggers tab.

---

## 10. Where things live

| | |
|---|---|
| `packages/core/src/alerts/pace.ts` | cadence, cost, due-ness. Pure |
| `packages/core/src/alerts/select.ts` | which changes are worth an email. Pure |
| `packages/core/src/alerts/digest.ts` | the email as strings, and per-recipient grouping. Pure |
| `workers/api/src/alerts/sweep.ts` | the tick: pick, guard, sweep, file, flush |
| `workers/api/src/alerts/budget.ts` | **the only place quota is read before spending** |
| `workers/api/src/alerts/routes.ts` | `/api/alerts/*` — what the tab reads, plus the dev-only `POST /run` |
| `workers/api/src/security.ts` | `isLocalRequest` — the one dev-vs-prod discriminator |
| `workers/api/src/email.ts` | Resend, and the recipient allowlist |
| `workers/api/src/searchRun.ts` | the shared engine — two callers, one behaviour |
| `web/src/pages/Alerts.tsx` | the tab, ordered problems-first |
| `web/src/alerts.ts` | the SPA's reading of `AlertSchedule` — the health ladder, its colours, and the cadence format. Pure |
| `web/src/pages/Routes.tsx` | the rail's bell and the route header's alerts chip, both off the same ladder |
| `migrations/0001_init.sql` | `search_runs.calls` and `.route_id`, the `alert_*` columns on `tracked_routes`, `alert_outbox`, `alert_deliveries` |

**Three surfaces now draw alert state, and they share one ladder.** The Alerts
tab's table, the Routes rail's per-route bell and the selected route's header
chip all resolve through `alertHealth` / `ALERT_HEALTH` in `web/src/alerts.ts`,
which only *names and orders* what `GET /api/alerts/schedule` already decided.
Nothing in the SPA re-derives due-ness or cadence — §4's rule that the page must
quote the scheduler's own answer applies to every one of them, not just the tab.
The Routes page reads that endpoint through the **same TanStack key the shell's
health dot polls** (`["alert-schedule"]`), so it is a cache read rather than a
second request; do not give it a competing `refetchInterval`.

Note also that `GET /api/dashboard`'s explicit column list must carry the alert
columns. It did not, and because the route form sends `alertsEnabled` on every
save rather than omitting it, editing any route silently unenrolled it — and
re-enabling churned `alert_last_digest_at` through `baselineOnEnable`.

Invariants worth restating, because each one fails quietly:

- **A sweep must never be able to fail invisibly.** No failure email exists; the
  Alerts tab and Workers Logs are the whole of the safety net. The dev-only
  `POST /api/alerts/run` returns the entire `TickResult` for the same reason: a
  manual trigger that answered `{ok:true}` would rebuild "swept nothing and
  refused to sweep look identical" on the one page built to tell them apart.
- **Only `alerts/budget.ts` reads quota before spending.** Anywhere else is the
  guard leaking back into the interactive paths. `runAlertTick`'s `force` option
  is a *cadence* override — it must never grow a way past `decideSweep`.
- **The first digest for a route is suppressed** unless it already holds a
  recent search (`baselineOnEnable`), or the diff's own semantics turn it into
  thousands of `new`.
- **A paused route files nothing.**
- **`alert_on = []` is a 400**, never a stored value.
- **The route's read filters come from `ROUTE_FINDS_MATCH`**, never a
  reimplementation.

## See also

- `CLAUDE.md` — the invariants in short form.
- `docs/SEATS-AERO.md` — the Partner API, the chunk economics, and §9 on quota.
- `docs/SOURCES.md` — the plug-in contract, and the other ingest path
  (`npm run gather`), which still runs on no schedule.
