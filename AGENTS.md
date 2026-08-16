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
node --test test/join.test.ts              # one file
node --test --test-name-pattern 'grace'    # one test by name
```

Run `npm run typecheck && npm test` before calling a change done.

## Rules that bite

Each of these is cheap to violate and expensive to notice. Reasoning for all of them is in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Erasable syntax only.** Node strips the types; there is no compiler. No enums, namespaces,
  parameter properties or decorators.
- **Import specifiers carry the real extension** — `import { config } from './config.ts'` — and
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
  `src/sheet/verify.ts` before going near it.
- **One inserted row per run is an invariant, not a setting.** Plan indices are pre-write and
  `insertDimension` applies cumulatively, so a second insert would land a row high;
  `assertPlanSafe` refuses it outright.
- **Tests must not reach the network, the real `./data`, or the real spreadsheet.** Use `withFetch`,
  `withConfig` and `withTempDataDir` from `test/helpers.ts` — on a real checkout `./data` holds a
  live OAuth token, and `.env` holds a live `SHEET_ID`. The helpers module forces `sheetId` to
  undefined and `sheetSyncMode` to `off` on import for exactly that reason.

## Where things live

| Path | Role |
| --- | --- |
| `src/refresh.ts` | `FeedState` — the whole orchestration; the only thing that mutates |
| `src/join.ts`, `src/ics.ts` | Pure: calendars + library + releases → events → ICS string |
| `src/sources/` | One module per upstream (CDN calendars, OAuth library, film releases, show catalogue, the sheet) |
| `src/simkl/` | SIMKL transport: error classification, device-flow auth, the per-title lookup pool, item field readers, API types |
| `src/sheets/` | Google transport: service-account JWT, Sheets requests, API types |
| `src/backoff.ts` | Retry timing and the `HttpError` base, shared by both transports |
| `src/sheet/` | Pure: grid → blocks → plan → guard → requests → verify |
| `src/sheet-sync.ts` | The write protocol. The only thing that writes to the spreadsheet |
| `src/server.ts` | Fastify; two routes, no state of its own |

Layering runs downward only, and `join`/`ics`/`sheet/*` stay pure — they take options with
config-backed defaults rather than reading `config` mid-body.

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

`sources/calendar.ts` keeps a module-level cache; call `clearCache()` in tests that touch it, and
`clearTokenCache()` from `sheets/auth.ts` in tests that reach Google. `sources/shows.ts` has no
cache of its own — `SheetSync` retains catalogue results and decides when to re-read.

The sheet sync's tests are weighted towards `sheet-safety.test.ts` on purpose: a one-row
misalignment is the only catastrophic failure the feature has, and the guards and the request
ordering are what prevent it.

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
`src/simkl/` or `src/sources/`; `src/simkl/types.ts` still wins on payload *shape*, because it is
written from live responses and the docs disagree in places.

Google's Sheets API is at <https://developers.google.com/workspace/sheets/api/reference/rest>.
Two things it does not offer, checked rather than assumed: there is no revision surface at all, and
Drive's revisions can be listed, fetched, deleted or pinned but never named, created or reverted to.
That is why the sync snapshots a tab before writing instead of using version history.
