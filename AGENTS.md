# AGENTS.md

Authoritative guidance for coding agents working in this repository, and a fast orientation for
humans. Why the code is shaped this way lives in [ARCHITECTURE.md](ARCHITECTURE.md); what the
service does for its user is in [README.md](README.md). What's here is what you need before
touching anything.

## What this is

A self-hosted service that joins SIMKL's public airdate CDN with your private OAuth library and
serves the intersection as a subscribable iCal feed. No database, no build step, two runtime
dependencies (`fastify`, `ical-generator`).

Off the same poll it also keeps a hand-maintained Google Sheet of watch progress current. That
half is inert unless `SHEET_ID` and a Google credential are both set.

## Commands

```sh
npm start                                  # run the service (src/index.ts)
npm run login                              # SIMKL device/PIN flow; writes data/token.json
npm run login -- --force                   # re-authorise over an existing token (the `--` is required)
npm test                                   # whole suite (node --test)
npm run typecheck                          # tsc --noEmit; the only "build" that exists
node --test test/feed/1-join.test.ts       # one file
node --test --test-name-pattern 'grace'    # one test by name
```

Run `npm run typecheck && npm test` before calling a change done.

## Rules that bite

Each of these is cheap to violate and expensive to notice. Reasoning for all of them is in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Erasable syntax only.** Node strips the types; there is no compiler. No enums, namespaces,
  parameter properties or decorators.
- **Import specifiers carry the real extension** — `import { config } from '../shared/config.ts'` — and
  type-only imports must say `import type`.
- **Never slice an ISO airdate.** Airdates are UTC instants; `iso.slice(0, 10)` is wrong for ~19%
  of entries in `America/New_York`. Parse with `instantFrom()` and convert with `plainDateIn()`,
  which cannot produce a date without being told a zone.
- **Every date and duration is a Temporal value.** A moment is a `Temporal.Instant`, a local calendar
  date a `Temporal.PlainDate`, a span or an interval a `Temporal.Duration`. ISO strings survive only
  where they cross a boundary — persisted JSON, HTTP params, `/healthz` — and are parsed at the first
  consumer, and written through `nowIso()` so every stored timestamp keeps one width. `Date` survives
  in three places only: `Retry-After`, which may be an RFC 7231 HTTP-date Temporal cannot parse, and
  the Google token cache and SIMKL device-flow deadline, which are process-internal epoch-millisecond
  countdowns with no zone and no calendar in them.
- **Build durations from days and below, never years, months or weeks.** `Duration.compare`, `total`
  and `round` require a `relativeTo` anchor exactly when one of those three is nonzero; below that a
  day is exactly 24 hours and the operations are total. It also keeps the sheet's 90-day recency
  window an exact span rather than one that moves by an hour twice a year. Pinned in
  `test/shared/dates.test.ts`.
- **`Temporal.PlainYearMonth` is never used.** `monthsBack` builds `${year}/${month}/` archive URLs
  and `PlainYearMonth.toString()` pads the month, which is a 404. Read `.year` and `.month` off a
  `PlainDate`.
- **Measure a span on a monotonic clock, a moment on the wall clock.** `performance.now()` where both
  endpoints are readings taken inside this process and the window is fine enough that a clock step
  matters — request latency, the snapshot freshness gate. Wall time where either endpoint is the
  timestamp of a real event, which is why `cutoffFrom` cannot move: it compares against a SIMKL
  timestamp from another machine.
- **UIDs are derived, never random.** A fresh UID each render makes calendar clients duplicate
  events instead of updating them.
- **Nothing in the refresh path may be fatal.** Failures land in a per-subsystem error slot and are
  reported by `/healthz`; the process stays up and keeps serving the last good feed.
- **The feed is only replaced when both halves of the join are present**, so a partial refresh
  never overwrites a complete feed loaded from disk.
- **Never pull the whole library on a timer.** Gate on `/sync/activities` and ask for a delta —
  `/sync/all-items?date_from=…`, one request returning only what changed. SIMKL answers a burst of
  uncached sync calls with `401 user_token_failed`, not a `429`, so the symptom looks like a dead
  token rather than a rate limit. It clears on its own — the same token works again minutes later,
  so wait it out rather than reaching for `npm run login`; re-authorising fixes nothing the wait
  would not. This applies to ad-hoc inspection scripts too, not just the refresh path.
- **The gate and the watermark are different timestamps.** `librarySignature` triggers the pull and
  covers the five status timestamps only; `activities.all` is what goes out as `date_from`. Gating
  on `all` instead would pull a delta on every poll, because it rolls up `playback` — a scrobbler
  reporting progress moves it continuously and changes nothing the feed or the sheet can see.
- **Ask for a second more than you need.** `date_from` is compared strictly greater at one-second
  granularity, so passing back `activities.all` verbatim returns nothing at all, and a write landing
  in that same second but committed after the activities read would never be asked for again.
  `deltaFrom` backs the watermark off by a second; `mergeDelta` is an idempotent upsert so the
  overlap is free. A watermark also advances only *after* the call that consumed it returns.
- **`removed_from_list` is not a status, and removals are in no delta.** A removal moves that
  timestamp and nothing else, so the only way to learn what went is to pull the membership set
  (`extended=simkl_ids_only`, 47 KB for 741 items) and intersect — but only within the categories
  whose stamp actually moved, since an empty category is *omitted* from the response, so a payload
  that lost one is the same bytes as a category the user emptied. Two traps: a response that would
  drop most of a category is refused and answered with a **full pull** rather than re-asked, because
  the question is unanswerable by diffing and only the whole library settles it; and
  `/sync/all-items/{type}/{status}` **fails open** —
  an unrecognised status segment returns every item of that type instead of a 404, so
  `/sync/all-items/movies/removed_from_list` is a full-library download, not an error.
- **`item.status` is the only membership there is.** The library is one record per SIMKL id, so a
  move is a replacement and no stale copy survives to disagree. The one thing a record cannot supply
  is its *type*: an anime record is a show record plus `anime_type`, and both nest their title under
  `show`, so `LibraryEntry.type` has to come from the top-level response key it arrived under.
  The feed's airing rule is negative — a record with no `status` is still a title we hold — and its
  film rule is positive, because the library retains every completed film and a negative rule there
  would sweep hundreds of them into the feed and into a per-title lookup each.
- **The feed reads membership, never progress.** `join` takes exactly two things off a library
  record: its id and its `status`. Watch counts, `seasons[]` and `last_watched_at` are the sheet's
  business, and a title moving between `watching` and `completed` — which SIMKL does every time you
  catch up and every time the next episode drops — must produce the identical feed. So the render is
  gated on `mergeDelta`'s `reshaped`, not its `updated`: the poll fires on every episode you mark, and
  rendering on that rewrites the file for a fresh `DTSTAMP` and nothing else. `test/feed/1-join.test.ts`
  holds the invariance directly; `test/orchestrator.test.ts` holds the render gate.
- **`extended` does nothing on the per-title endpoints.** `/movies/{id}`, `/tv/{id}`, `/anime/{id}`
  and `/tv/episodes/{id}` return byte-identical responses with and without it. On `/sync/all-items`
  it is the gatekeeper: `extended=full` alone turns on `seasons[]`, and `episode_watched_at=yes` and
  `include_all_episodes=yes` are no-ops without it. `ids.simkl` needs none of them.
- **Never write a formula cell, and never write a show row except `Status`.** Every derived cell on
  a show row rolls up from the season rows beneath it. Writing one replaces a live roll-up with a
  frozen number, and nothing would ever notice.
- **Ask the plan, not the grid.** Whether a write landed and which rows a rollback may delete are
  both answered from the planned writes — is this cell present where it was planned? Row growth
  answers neither: `batchUpdate` is atomic, and an insert whose batch failed leaves the count
  unchanged. Reading growth as "it landed" freezes the process over an untouched sheet.
- **`userEnteredValue` is only stable while the grid is.** Inserting a row makes Sheets rewrite the
  relative A1 references in every formula it shifts, so the verifier compares formulas for still
  *being* formulas across an insert rather than for their text. Tightening that back to text
  equality is the one change here that can corrupt the sheet outright — read
  `src/sheet/6-verify.ts` before going near it.
- **One inserted row per run is an invariant, not a setting.** Plan indices are pre-write and
  `insertDimension` applies cumulatively, so a second insert would land a row high;
  `assertPlanSafe` refuses it outright.
- **Every value interpolated into the status page goes through the `html` tag.** Show titles,
  spreadsheet contents and upstream error bodies all reach it, so `2-html.ts` escapes by default and
  `raw()` is reserved for the stylesheet. The safe-HTML brand is a module-private `Symbol` because a
  `{ html: string }` duck type is forgeable by any object with that key — including one parsed out of
  `sheet-runs.json`, which the page renders verbatim. That file is the only one to audit for this.
- **The status page loads nothing off-origin, and sends `Referrer-Policy: no-referrer`.** The feed
  token is in the page's own URL, so any external asset — a font, a CDN script, an image — would
  carry it to a third party in a `Referer` header. That is the live concern, and it is about who
  else sees the token rather than about the page showing it: the logs, `/healthz` and this page are
  all trusted surfaces, and printing the token or the spreadsheet id in them is fine. The page
  renders the tab *name* because that is what a reader can act on, not because the id is a secret.
- **`sheet-runs.json` is observational, never control.** Nothing may read it to decide behaviour, so
  a corrupt or deleted history cannot change what the sync does. See ARCHITECTURE.md.
- **Tests must not reach the network, the real `./data`, or the real spreadsheet.** Use `withFetch`,
  `withConfig` and `withTempDataDir` from `test/helpers.ts` — on a real checkout `./data` holds a
  live OAuth token, and `.env` holds a live `SHEET_ID`. The helpers module forces `sheetId` to
  undefined, `sheetSyncMode` to `off`, and `dataDir` to a throwaway path on import for exactly that
  reason: the sheet run log made a green suite write into the live data dir beside a real token.
  `clearSheetRuns()` from `sheet/io/journal.ts` belongs in any test that touches the history, the
  same way `clearCache()` does for the CDN.

## Where things live

Five buckets, and the folder a file sits in answers two questions: **which half of the project
needs it**, and **is it transport or business logic**.

| Path | Role |
| --- | --- |
| `src/orchestrator.ts` | `Orchestrator` — the poll, the timers, the state `/healthz` projects from; owns the library and drives both halves |
| `src/server.ts`, `src/index.ts`, `src/login.ts` | Fastify (three routes, no state of its own), boot, and the device-flow CLI |
| `src/shared/` | Used by both halves, and with no feature knowledge at all: config, dates, errors, logger, signals, atomic-write |
| `src/health.ts` | The state projection both `/healthz` and the status page read. Pure; `buildHealth` takes flat state, `healthResponse` narrows it to the endpoint's contract |
| `src/library.ts` | How the library is gated, merged and read: the signatures, the delta merge, the removal diff, the counts. Beside the orchestrator, which is the only thing that owns a library |
| `src/api/` | Every HTTP client, and no domain rules. `backoff.ts`, `cdn.ts`, `pool.ts`, `requests.ts`, `simkl/`, `google/`. `simkl/types.ts` holds only shapes SIMKL sends; anything this service derives lives with the module that derives it. `requests.ts` is the one exception to "no domain rules": `RequestComponent` names the callers, because which part of the service asked is not a fact any transport holds |
| `src/feed/` | iCal only |
| `src/sheet/` | Google Sheet sync only |
| `src/status/` | The HTML status page. Reads both halves and the request log; `server.ts` is its only reader |

`src/status/` is a **layer**, not a fourth peer: it sits above both halves and below `server.ts`,
may read from either, and names `Orchestrator` as a *type only*. **Nothing in `feed/`, `sheet/`,
`api/`, `shared/` or `orchestrator.ts` may import from it** — the last of those would be a real
runtime cycle, not an erased one. Layering still runs downward only; there is one more level.

Each half is an **impure shell around a numbered pure core**: `io/` holds whatever talks outside
the process, and the rest carries its pipeline position in the filename, so `ls` prints the order.

`src/feed/` — FETCH → JOIN → RENDER → SAVE

| Step | Module |
| --- | --- |
| FETCH | `io/calendar.ts` (CDN airdates), `io/movies.ts` (per-title film releases) |
| JOIN | `1-join.ts` — calendars × library × releases → events |
| RENDER | `2-ics.ts` — events → an ICS string |
| SAVE | `io/store.ts` — the rendered feed on disk, and back on boot |
| — | `feed.ts` — the cycle that runs them |

`src/sheet/` — INDEX → READ → PARSE → PLAN → GUARD → BUILD → APPLY → VERIFY → ROLLBACK

| Step | Module |
| --- | --- |
| INDEX | `1-progress.ts` — library → what was watched, and the early-out that decides whether to read the grid at all |
| READ | `io/spreadsheet.ts` (the tab), `io/catalogue.ts` (SIMKL per-title) |
| PARSE | `2-grid.ts` — snapshot → blocks |
| PLAN | `3-plan.ts` — grid + library + catalogue → a plan |
| GUARD | `4-guard.ts` — refuse a plan that does not re-derive |
| BUILD | `5-requests.ts` — a plan → one ordered batch |
| APPLY | `io/spreadsheet.ts` again |
| VERIFY | `6-verify.ts` — did the write do exactly what was planned |
| ROLLBACK | `5-requests.ts` again, in separate batches |
| — | `backups.ts` — the snapshot tab's whole life: what it is called, how it is found, and the three ways it ends |
| — | `sync.ts` — the protocol that runs them |

`src/status/` — MODEL → RENDER

| Step | Module |
| --- | --- |
| MODEL | `1-model.ts` — a `StatusInput` of plain data → a `StatusModel`. Pure |
| RENDER | `2-html.ts` — a `StatusModel` → one self-contained page. Pure; owns `html`/`raw`/`escapeHtml` |
| — | `status.ts` — the shell: the only file here that names `Orchestrator`, the only one that reads the clock, and the only one that reaches past both halves to `api/requests.ts` |

Layering runs downward only, and everything numbered stays pure — those modules take options with
config-backed defaults rather than reading `config` mid-body.

Renumbering on insertion is the cost of this, and is the right move when it comes up: appending a
step out of order forfeits the only thing the scheme buys. One number is already approximate —
`5-requests.ts` builds the write batch *and* the rollback requests that run after `6-verify.ts`.

Where a sheet run stopped is `SheetSyncStatus`, which `/healthz` reports as `sheet.status`:

| Status | Reached after |
| --- | --- |
| `idle` | PLAN produced nothing to write |
| `reported` | GUARD passed, and `report` mode stops there |
| `refused` | GUARD threw — nothing was written |
| `failed` | the batch errored and VERIFY found none of it in the sheet |
| `applied` | VERIFY passed |
| `rolled-back` | VERIFY failed and the snapshot went back cleanly |
| `frozen` | the rollback did not complete; no further writes this process |

## Tests

`node:test` + `node:assert/strict`, one file per module, no framework and no mocking library.
`test/helpers.ts` is doing real safety work, not saving keystrokes:

- `withFetch(handler, fn)` — swaps `globalThis.fetch` and records every URL. Most assertions are on
  the call log: that a poll made one request rather than eight.
- `withConfig(overrides, fn)` — config is a singleton; a missed restore leaks into other files.
- `withTempDataDir(fn)` — `config.dataDir` defaults to `./data`, which on a real checkout holds a
  live OAuth token.
- On import it sets `config.retryBaseMs = 1`, so a retry path takes microseconds rather than 15
  seconds, and blanks the sheet credentials as described above.
- `sheetSnapshot(rows)`, `cellOf(spec)`, `showRow`/`seasonRow` and `libraryOf(...items)` build sheet
  and library fixtures. A cell spec of `{ formula }` is the one that matters: only
  `userEnteredValue.formulaValue` distinguishes a formula, and a formula target must be refused
  unconditionally.

`api/cdn.ts` keeps a module-level cache; call its `clearCache()` in tests that touch a calendar,
and
`clearTokenCache()` from `api/google/auth.ts` in tests that reach Google. `sheet/io/catalogue.ts`
has no cache of its own — `SheetSync` retains catalogue results and decides when to re-read.

`api/cdn.ts` has no test of its own: every path through it is exercised by
`test/feed/io/calendar.test.ts`, which is the only caller and the one that knows what a usable
payload looks like.

`test/sheet/fixtures.ts` holds the one grid every sheet suite plans against, plus `cell`, `planOf`
and `insertAt`. It is there rather than in `helpers.ts` for the reason that file already gives about
`showRow`/`seasonRow`, one level up: `grid` is a positional array and every suite hard-codes row
indices against it, so a second copy that drifts re-points every index in the file that has it —
silently. The `test/**/*.test.ts` glob never runs it as a suite.

The sheet sync's tests are weighted towards `4-guard.test.ts` and `5-requests.test.ts` on purpose:
a one-row misalignment is the only catastrophic failure the feature has, and the guard and the
request ordering are what prevent it.

## CI

`npm ci && npm run typecheck && npm test` on Node 26.0.0 and 26, then build, smoke test and publish
the image. 26.0.0 is the real floor — it is the release Temporal shipped in, and Temporal is a
*build-time* option rather than a runtime flag, so code using it typechecks green against
`@types/node` and then throws `ReferenceError` on a build without it. Homebrew's `node` is such a
build; the nodejs.org binaries and `node:26-alpine` are not. That is why the matrix pins the floor
rather than testing only `lts`, and why `index.ts` asserts the global at boot.

The smoke test runs the built image and asserts `/healthz` answers with parseable JSON, that a wrong
feed token gets a 404 and the right one returns something starting `BEGIN:VCALENDAR`, and the same
pair for the status page — 404, then a 200 whose body opens `<!doctype html>` and contains no
`undefined` or `[object Object]`, which is what catches a field that failed to map. `/healthz` is
expected to answer `503`: nothing has been rendered without a token, and "the container is up" is
the only claim being made.

## Upstream API reference

SIMKL documents its API in an agent-readable form at <https://api.simkl.org/llms.txt>. It covers
every upstream this project touches — PIN device flow, `/sync/activities`, `/sync/all-items`, the
calendar files, per-title lookups — along with the rate limits. Read it before changing anything in
`src/api/simkl/` or the `io/` modules; `src/api/simkl/types.ts` still wins on payload *shape*, because it is
written from live responses and the docs disagree in places.

Google's Sheets API is at <https://developers.google.com/workspace/sheets/api/reference/rest>.
Two things it does not offer, checked rather than assumed: there is no revision surface at all, and
Drive's revisions can be listed, fetched, deleted or pinned but never named, created or reverted to.
That is why the sync snapshots a tab before writing instead of using version history.
