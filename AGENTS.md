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
  of entries in `America/New_York`. Use `localDate()`.
- **UIDs are derived, never random.** A fresh UID each render makes calendar clients duplicate
  events instead of updating them.
- **Nothing in the refresh path may be fatal.** Failures land in a per-subsystem error slot and are
  reported by `/healthz`; the process stays up and keeps serving the last good feed.
- **The feed is only replaced when both halves of the join are present**, so a partial refresh
  never overwrites a complete feed loaded from disk.
- **Never poll `/sync/all-items` directly.** Gate it on `/sync/activities` and refetch only the
  lists whose signature changed — that is what `staleLists()` is for. SIMKL answers a burst of
  uncached sync calls with `401 user_token_failed`, not a `429`, so the symptom looks like a dead
  token rather than a rate limit. It clears on its own — the same token works again minutes later,
  so wait it out rather than reaching for `npm run login`; re-authorising fixes nothing the wait
  would not. This applies to ad-hoc inspection scripts too, not just the refresh path.
  `LISTS` covers 11 lists rather than the feed's 7 because the sheet sync needs `hold` and
  `dropped`: for it, "absent from every list" has to mean *no information*. Widening it further
  costs call budget for nothing — the gate is what makes 11 affordable, not the count.
- **A list is where an item was found; `item.status` is where it belongs.** SIMKL reports a move
  against the destination list only, and `listSignature` advances only for the destination, so the
  source list is never refetched and the item sits in both forever. Anything asking "is this still
  being watched" must read `status` — `join`'s id sets and `indexLibrary`'s tie-break both do. But
  `status` alone cannot settle it: a stale copy of a dropped show and a fresh copy of an un-dropped
  one are the same bytes. Only the poll knows which list it just fetched, so `pruneSuperseded`
  evicts the stale membership there, at the one point the answer exists.
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
- **Tests must not reach the network, the real `./data`, or the real spreadsheet.** Use `withFetch`,
  `withConfig` and `withTempDataDir` from `test/helpers.ts` — on a real checkout `./data` holds a
  live OAuth token, and `.env` holds a live `SHEET_ID`. The helpers module forces `sheetId` to
  undefined and `sheetSyncMode` to `off` on import for exactly that reason.

## Where things live

Four buckets, and the folder a file sits in answers two questions: **which half of the project
needs it**, and **is it transport or business logic**.

| Path | Role |
| --- | --- |
| `src/orchestrator.ts` | `Orchestrator` — the poll, the timers, `/healthz`; owns the library and drives both halves |
| `src/server.ts`, `src/index.ts`, `src/login.ts` | Fastify (two routes, no state of its own), boot, and the device-flow CLI |
| `src/shared/` | Used by both halves, no feature knowledge: config, dates, errors, logger, signals, atomic-write — plus `library.ts`, the one shared *domain* module |
| `src/api/` | Every HTTP client, and no domain rules. `backoff.ts`, `cdn.ts`, `simkl/`, `google/` |
| `src/feed/` | iCal only |
| `src/sheet/` | Google Sheet sync only |

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
| — | `sync.ts` — the protocol that runs them |

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

`api/cdn.ts` keeps a module-level cache, re-exported through `feed/io/calendar.ts` so a test
clears the one it actually uses; call `clearCache()` in tests that touch it, and
`clearTokenCache()` from `api/google/auth.ts` in tests that reach Google. `sheet/io/catalogue.ts`
has no cache of its own — `SheetSync` retains catalogue results and decides when to re-read.

`api/cdn.ts` has no test of its own: every path through it is exercised by
`test/feed/io/calendar.test.ts`, which is the only caller and the one that knows what a usable
payload looks like.

The sheet sync's tests are weighted towards `4-guard.test.ts` and `5-requests.test.ts` on purpose:
a one-row misalignment is the only catastrophic failure the feature has, and the guard and the
request ordering are what prevent it.

## CI

`npm ci && npm run typecheck && npm test` on Node 22.18 and 24, then build, smoke test and publish
the image. 22.18 is the real floor — code using a newer API typechecks green against `@types/node`
and then crashes on the documented minimum, which is why the matrix pins it rather than testing
only `lts`.

The smoke test runs the built image and asserts `/healthz` answers with parseable JSON, a wrong
feed token gets a 404, and the right one returns something starting `BEGIN:VCALENDAR`. It expects
`503` there: nothing has been rendered without a token, and "the container is up" is the only claim
being made.

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
