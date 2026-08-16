# Harvesting airline sites: what we tried, what we learned, why we stopped

**Status: abandoned 2026-08-15.** This document exists so nobody spends another
month rediscovering it. It is the whole record; the working notes it replaces
(`docs/HARVEST.md`, `docs/SOURCE-ACCESS-LEDGER.md`) are gone.

The idea was straightforward: seats.aero is an aggregator, aggregators have gaps,
and a carrier's own booking form has no gaps by definition. So run a real Chrome
on a residential connection, drive the form the way a person does, read the JSON
the page fetches for itself, and POST it to the Worker. For roughly two weeks
that is what this repo did.

It does not work, and the reason is not the one everybody expects.

---

## 1. The one-sentence answer

**Anti-bot was never the wall. Product policy was.** Every carrier worth having
either refuses to price award travel to a logged-out visitor, or its miles are
unreachable from the currencies this app is about. A real browser solves
detection; it cannot solve a sign-in form.

---

## 2. What was actually built

At its peak the harvest stack was: a headed-but-off-screen Playwright browser on
a persistent Chrome profile, a request-capture layer that read a page's own XHR
traffic rather than its DOM, an anti-bot classifier, a recorder for capturing new
sites by hand, a CLI, a localhost daemon, an operator console in the SPA, a
per-source coverage model, and adapters for Alaska and Delta.

Two carriers were taken to the end of the ladder. Two more were probed and
closed. One aggregator and one keyed vendor API were found to work and still do.

| Source | Verdict | Why |
|---|---|---|
| **Alaska** | Worked | The only carrier that ever scraped cleanly: no reachable JSON API, but the results page server-renders the award matrix as a JS object literal. Shipped, ran, produced real finds. |
| **Delta** | Worked, worthless | Award search *is* offered logged out, the form drive worked, and it returned ~357 KB of real award itineraries every time. But SkyMiles takes **none** of the couple's four currencies, so nothing it found was ever bookable. |
| **United** | Closed — login | Award results are gated behind sign-in. Evidence in §3. |
| **Flying Blue** | Closed — login | The highest-value target (the only program all four currencies transfer to) and the most dangerous failure mode we found. Evidence in §4. |
| **PointsYeah** | Works, kept | An aggregator, not a carrier. Survives as a local source — see §7. |
| **seats.aero** | Works, kept | A keyed vendor API. Always ran on the Worker and still does. |

Alaska plus Delta is the whole return on the investment: one program that
scrapes, and one whose seats cannot be bought.

---

## 3. United — measured twice, with a control

United's award page (`/en/us/fsr/choose-flights?…&at=1`) renders fine in a real
browser from a residential IP. No Akamai challenge, no `428`, no interstitial —
that is what raw HTTP gets, and it turns out to be irrelevant. What appears
instead is a modal:

> **Continue shopping?** We can show you flight results with money. **You must be
> signed-in to see flight results with miles.**

The first pass (2026-08-08) recorded a screenshot of that modal and called it
closed. That was the right verdict for the wrong reason, and the wrong reason
mattered: the harvester read **captured XHR, not the DOM**, so a modal painted
*over* delivered data would have been irrelevant. The real question — *does the
page even issue the availability request?* — had not been asked.

Re-measured 2026-08-15, SFO→NRT 2027-04-01, off-screen Chrome, residential IP:

| # | What | `/api/flight` calls |
|---|---|---|
| 1 | Award URL (`at=1`), matcher `api/flight` | **0** |
| 2 | Award URL, every structured response kept | **0** of 20 captured |
| 3 | **Control** — identical URL, `at=0` (cash) | **1 — `FetchSSENestedFlights`, 200, 803,640 B** |
| 4 | Cash page → `Show price in: Miles` → **Update** | **0** |

Probe 2 is what makes it airtight: twenty XHRs came back on the award page (it
resolved both airports through `/api/airports/lookup/`), so page and capture
wiring were both healthy. It simply never asks for flights. Probe 3 holds every
variable fixed but the `at` bit and gets the full fare matrix. Probe 4 drove the
real UI — the results page carries a genuine `<select>` with `money`/`miles`/
`moneymiles` — and landed on a sign-in form over empty skeletons.

**The gate is in the front end, upstream of the network. There is no payload to
capture, therefore nothing a parser could be written against.** That is a closed
door, not a hard one.

United *cash* is wide open — `FetchSSENestedFlights` is a clean SSE stream — and
worth having, because a known cash fare makes a seat portal-bookable with every
currency the couple holds regardless of transfer partners. It is blocked on
schema, not access: `availability_snapshots.miles_cost` is `NOT NULL`.

---

## 4. Flying Blue — and the silent revert

Flying Blue was opened last because it was worth the most: `flyingblue` is the
only program **all four** of the couple's currencies transfer to.

First finding: the two endpoints the repo had recorded for it,
`/api/gql/bestoffers` and `/api/gql/availability`, **never existed.** Both
committed fixtures were `404`, `nginx`, `text/html`, 10,208 bytes each — the same
branded error page. They were a guess that got committed and then read back as
evidence.

The real API is one GraphQL endpoint, with the booking flow as a query parameter:

```
GET https://wwws.airfrance.us/gql/v1
      ?bookingFlow=LEISURE&brand=AF&country=US&language=en
      &operationName=<Op>&variables=<json>
```

The whole booking form was driven successfully — trip type, both station pickers,
the datepicker, submit — and it answers logged out with no challenge at all.
Then "Book with Miles" raises:

> **Flying Blue Miles** — Log in to your Flying Blue account to book a ticket
> with Miles. `[Close] [Log in]`

**The part worth remembering is how it fails.** Dismissing that dialog leaves the
switch reading `aria-checked="true"` while the search silently runs
`bookingFlow=LEISURE` and returns USD. Measured three ways — pointer click then
submit, close-button then submit, and a DOM-level `.click()` bypassing the CDK
backdrop entirely — all three produced a LEISURE payload with **zero**
occurrences of miles and `currencyCode: "USD"` throughout.

A source that trusted the toggle would have harvested cash fares, filed them as
award space, and **never errored**. Coverage would have been claimed. The
dashboard would have shown confident, wrong numbers. That is worse than no source
at all, and it is the failure mode this whole architecture is built to prevent.

---

## 5. Why signing in was never on the table

Every closed door had the same key, and it was ruled out from the start:

- An authenticated session ties a hobby project to a real loyalty account that
  can be closed **with the miles inside it**. The downside is uncapped and the
  upside is a personal dashboard.
- It moves the project from "reading a public page faster than a human would"
  to "operating an account under automation", which is a different thing to be
  doing and a different thing to explain.
- It would need real credentials on disk on a machine running unattended
  automation.

Given that, "the program requires login to see award prices" is a permanent
verdict, not a temporary one.

---

## 6. What was true and what we got wrong

Worth separating, because the mistakes are repeatable and the findings are not.

**Right, and still right:**

- Coverage as a stored fact. *"Did anyone actually check (route, date, program),
  and when?"* is a different question from *"is there space?"*, and only the
  former licenses deleting a row. That model outlived the scrapers and now
  carries Search and Alerts.
- Only `ok` and `empty` claim coverage. A refused task must never be able to
  delete a real find.
- `coveredDates` read off the payload, never off the plan.
- Write-on-change against the **stored** hash. A re-run that changes nothing
  upstream writes zero rows — still the cheapest smoke test this pipeline has.
- Telling "the source said no" apart from "the source said there is no award
  space". Collapsing those two is how the pre-pivot design recorded "United is
  unusable" when it was actually being challenged.

**Wrong:**

- **Committing invented endpoints.** The Flying Blue recipes were guesses that
  hardened into recorded fact because they sat in a file next to real ones. A
  fixture that is a 10 KB `nginx` 404 page is not a fixture.
- **Screenshotting the viewport to prove a network claim.** The United modal was
  photographed for a week before anyone asked whether the request was issued.
- **No control request.** Every early "blocked" verdict was unpaired. Adding one
  identical-but-for-one-variable request changed the meaning of half the ledger.
- **Reading the toggle instead of the payload.** See §4. The general rule: verify
  the *answer* has the property you asked for, never that the *control* looks
  like you set it.
- **Sinking cost into detection.** Two weeks went into anti-bot handling — the
  persistent profile, the off-screen window, the challenge classifier, the
  pacing ladder. All of it worked. None of it mattered, because no carrier that
  matters was refusing us for being a robot.

---

## 7. What survived, and why

The scrapers are gone. The *abstraction* is not, because two sources still work
and they work in two different places:

- **seats.aero** — a keyed vendor API that authenticates the credential rather
  than judging the client, so the Worker may call it directly. It is Search and
  it is Alerts. `docs/SEATS-AERO.md`.
- **PointsYeah** — an aggregator, and the only source this app has for `cathay`
  and `eva`. Its posture from a datacenter IP has never been measured, so it is
  pinned to `runtime: "local"` and run by `npm run gather`. `docs/POINTSYEAH.md`.

That split is now a first-class part of the design rather than an accident of
history: a source declares **where it may run**, and neither runner can pick up
the other's. See **`docs/SOURCES.md`** for the plug-in contract, which is also
what a third party would implement if this were ever opened up.

The ingest machinery survived under new names, because a seats.aero search is
structurally the same thing a harvest was — it opens a run, records tasks, claims
coverage:

| was | is |
|---|---|
| `harvest_runs` / `_tasks` / `_logs` / `_coverage` | `search_runs` / `_tasks` / `_logs` / `_coverage` |
| `POST /api/harvest/{runs,tasks,finish}` | `POST /api/ingest/*` |
| `X-Harvest-Token` / `HARVEST_TOKEN` | `X-Ingest-Token` / `INGEST_TOKEN` |
| `packages/harvest` | `packages/local-sources` |
| `npm run harvest` | `npm run gather` |
| `api:seatsaero`, `freetool:pointsyeah` | `seatsaero`, `pointsyeah` |

A migration did that, and also deleted every row written by `scraper:alaska`,
`browser:delta` and `mock` — with no writer left, nothing would ever have
refreshed or pruned them and they would have read as current forever. That
migration is no longer in `migrations/`: the schema was collapsed back to a
single `0001_init.sql` at the BertBooker rename, when both databases were
recreated empty. The rename it performed is baked into the current schema; only
the row purge is gone, and a database with no rows has nothing to purge.

---

## 8. If you are thinking about reopening this

Read §3 and §4 first, then ask whether you have a **genuinely new kind of
evidence**. Re-running the probes above is not new evidence.

- **Do not reopen United awards** unless United starts showing logged-out award
  prices again. A new kind of test would be a surface that is not the
  `fsr/choose-flights` app at all.
- **Do not reopen Flying Blue awards** without a login decision. The anti-bot
  question is settled: there isn't one.
- **Delta** is technically reopenable and pointless: SkyMiles takes none of the
  couple's currencies, so only a cash fare could ever make a Delta seat
  reachable.
- **Alaska** is the only carrier that ever scraped cleanly, and seats.aero
  already carries it (`alaska` is in `SEATSAERO_PROGRAM_MAP`). Rebuilding the
  browser stack for one program that is already covered is not a trade.

The thing genuinely worth having, and blocked on something other than access, is
**cash pricing**: both United and Flying Blue serve revenue fares to logged-out
visitors, and a known cash fare makes a seat bookable through any card's travel
portal regardless of transfer partners. What stops it is the schema —
`availability_snapshots.miles_cost` is `NOT NULL` — not the carriers. That is a
much smaller problem than the one this document is about.
