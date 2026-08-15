# Architecture

How the service is put together, and the constraints that are easy to break without noticing.
For commands and test conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for the short version of
the rules below, [AGENTS.md](AGENTS.md).

## The shape

Two data sources that are useless alone, joined on the SIMKL id:

```
data.simkl.in/calendar/v2/*.json   (public CDN, airdates, whole database)  ─┐
api.simkl.com/sync/all-items/…     (OAuth, your library, no dates)         ─┤─ join ─→ ICS
api.simkl.com/movies/{id}          (per-film release dates)                ─┘
```

`FeedState` (`src/refresh.ts`) is the whole orchestration: it holds the rendered ICS in memory,
owns two timers, and is the only thing that mutates. **Requests never trigger a fetch** — a client
polling hard cannot amplify into SIMKL traffic, and a SIMKL outage degrades to a stale feed rather
than an empty one.

Layering, downward only:

- `src/simkl/` — transport. `client.ts` (retry/backoff, `SimklError`/`SimklAuthError`, `classify`),
  `auth.ts` (device flow, token file), `types.ts` (only shapes SIMKL actually sends — no
  freshness or bookkeeping fields).
- `src/sources/` — one module per upstream. `calendar.ts` (CDN, conditional GET, in-process cache,
  monthly archives), `library.ts` (authenticated lists, activities gating), `movies.ts` (per-title
  release-date resolution).
- `src/join.ts` → `src/ics.ts` — pure. Given calendars + library + movie releases, produce
  `FeedEvent[]`, then a string. Both take options with config-backed defaults rather than reading
  `config` mid-body, so they stay testable.
- `src/server.ts` — Fastify, two routes, no state of its own.

## The sheet sync

A second consumer of the same poll, and structurally separate from the feed: `src/sheets/`
(transport), `src/sheet/` (pure), `src/sheet-sync.ts` (the protocol). Inert unless `SHEET_ID` **and**
a Google credential are both supplied — a target with no credential stays off rather than filing an
ENOENT once per poll.

It writes exactly three things — a season row's `Episode` count, a season row's `End` date, and a
show row's `Status` — and inserts a season row when a new season is started. Nothing else, ever.

```
library (already fetched)  ─┐
/tv/episodes/{id}           ─┤─ plan ─→ guard ─→ batchUpdate ─→ verify ─→ (rollback)
/tv/{id} | /anime/{id}      ─┘
```

The whole cycle — read, plan, guard, write, verify — happens inside one poll, so what was planned
and what was written describe the same grid. A snapshot older than 120s is discarded and the cycle
restarts **from the read**, not from the write.

Why each piece is the way it is:

- **The sheet's own show-row formulas do the roll-ups.** Every derived cell on a show row
  (`Season`, `Episode`, `End`, `Episodes`, `Length`) is a self-sizing formula over the season rows
  beneath it. That makes the show row read-only to the sync, makes an insert need no formula
  rewriting, and is why the never-write-a-formula rule is unconditional.
- **Columns are resolved by header, never by position** — the columns get rearranged. A missing,
  renamed or duplicated label writes nothing at all, because a duplicate makes "which column is
  `Episode`" unanswerable and the wrong answer is a real edit to the wrong cell.
- **Which SIMKL entry a row belongs to is decided by where its id sits**, never by `Type`. A season
  row's own id wins; a blank one inherits the show row's. Both exceptions exist in the live sheet
  and are independent of each other.
- **`Episode` on a season row is a count, not an episode number**, because `Length = Episodes ×
  Episode`. The two coincide for in-order viewing, which is exactly why writing the highest episode
  number would survive testing and corrupt every total.
- **A season is complete only when `aired === total` AND `watched >= total`.** "Every aired episode
  watched" dates a season that is still running, and a dated season is never revisited.
- **Reads use `spreadsheets.get?includeGridData=true`, writes use `batchUpdate`.** The read gives
  `userEnteredValue` (the only definitive formula test) and `effectiveValue` (true date serials);
  the write is atomic, ordered, leaves formats alone, and sends `{numberValue: 46265}` rather than a
  date string that `08/15` and `15/08` misparse identically for twelve days a month.
- **Verification diffs `userEnteredValue`, never `effectiveValue`.** Writing one cell recalculates
  five formulas, so `effectiveValue` moves in cells nobody wrote. `userEnteredValue` changes only
  when someone writes — **while the grid holds still**. Inserting a row is the exception, and it
  cost a corrupted sheet to learn: Sheets rewrites the relative A1 references in every formula the
  insert shifts, so `=I609*F609` becomes `=I610*F610` with nobody having typed anything. Across an
  insert, a formula is therefore checked for still *being* a formula rather than for its text.
  Literals stay strictly compared, and they are what catches a misalignment — every literal on a
  season row moves with the row.
- **A write is never retried.** `batchUpdate` is atomic but not idempotent — a retried
  `insertDimension` inserts two rows. Reads opt into retry; writes never do.
- **Catalogue lookups are gated per title, by watch activity.** `/sync/activities` resolves to a
  list and never to a show, so a poll knows only that *something* moved. Without a second gate,
  watching one episode re-reads the catalogue of every eligible show — roughly 28 calls for a
  one-cell edit. `SheetSync` retains results across polls and stamps each id with the
  `lastWatchedAt` it held at the time; `planLookups` re-requests only ids whose value moved. Watch
  activity is the right trigger because it is the trigger for everything the sync writes: a season
  cannot become complete without being watched. The 24h ceiling is the backstop for the one thing
  that changes with no library activity — `/tv/{id}` status flipping on a renewal — and is daily
  for the same reason `movieRefreshMs` is.
- **The retention lives in `SheetSync`, not in `sources/shows.ts`.** The source fetches; the caller
  decides when, exactly as `movies.ts` and `FeedState` divide it. A TTL cache under the source
  would serve a stale episode list for a show the caller just decided to refresh *because* it
  changed — and the planner would silently see a different catalogue than it asked for, which
  changes what `Status` derives to.
- **Rollback is not partial-write recovery**; batchUpdate leaves no half-applied state. It exists
  for the case where *the plan was wrong*, which is why its restore set comes from the observed diff
  rather than from the plan.
- **Request order is load-bearing**: edits to pre-existing rows (descending), then the
  `insertDimension`, then the new row's fill — which shares a row index with the insert, so any
  "edits before inserts" rule overwrites a real row.
- **A rollback splits into separate batches**: delete, re-read, then restore. No single ordering is
  safe once formulas are involved, because `deleteDimension` rewrites the references in everything
  it shifts — including text written moments earlier in the same batch. Deleting first also does
  most of the work, since Sheets rewrites the formulas back on the way out exactly as it did on the
  way in, leaving a plain diff against stable indices (`verify` with an empty plan).

## No build step

Node strips the types itself. There is no `dist/`, no bundler; the code that runs is the code you
read. `tsc` is a checker only. Consequences that bite:

- **Erasable syntax only** — no enums, namespaces, parameter properties or decorators.
  `erasableSyntaxOnly` makes these compile errors rather than runtime failures.
- **Import specifiers carry the real extension**: `import { config } from './config.ts'`.
- **Type-only imports must say so** (`verbatimModuleSyntax`): `import type { Library } from ...`.

## Invariants worth knowing before changing anything

- **`render()` only replaces the feed when both halves are present.** A partial refresh must never
  overwrite a complete feed loaded from disk.
- **`safeRender()` serialises renders through a promise chain.** Both timers end there and coincide
  every six hours at the default intervals; overlapping runs would race on the disk save.
- **Errors are per-subsystem** (`calendar`, `library`, `render`, `sheet`). The timers must not clear
  each other's failures. Nothing in the refresh path is allowed to be fatal — the process stays up
  and `/healthz` reports why. `errors.sheet` is reported but deliberately excluded from
  `Health.ok`: `/healthz` is the container healthcheck and the CI smoke test, and a frozen sheet
  sync must not restart the container or fail a deploy.
- **Only `feed.ics` and `token.json` are persisted.** No control state outlives the process, so a
  restart always resyncs. Both are written 0600 through `writeFileAtomic`.
- **UIDs are derived, never random.** A fresh UID each render makes clients duplicate events
  instead of updating them.
- **`localDate()` is the highest-risk conversion in the project.** Airdates are UTC instants;
  `iso.slice(0, 10)` is wrong for ~19% of entries in `America/New_York`. Never slice.
- **The library says `ids.simkl`, the calendar says `simkl_id`.** `itemSimklId` bridges them; that
  is the entire join.
- **Films do not come from the CDN calendar.** `movie_release.json` covers a rolling 33-day window
  with placeholder times, so films are resolved per title and re-read daily on their own clock —
  a studio delay produces no library activity to gate on.
- **`config` is a process-wide singleton** built by `buildConfig(env)`. Every numeric setting is
  clamped rather than validated fatally: a running feed beats a container that will not boot.

## Domain rules encoded in the join

`completed` is treated as watching (SIMKL marks an ongoing show completed once you're caught up).
Plan-to-watch contributes premieres only. Aired episodes linger for `GRACE_DAYS` and that lingering
is deliberately *not* filtered by watch state. Anime is a separate SIMKL type, not a genre, and
carries no season number. A grace window past two days pulls monthly archives, whose URLs use an
**unpadded** month.

## Further reading

`README.md` has two collapsed sections worth reading before touching the refresh logic: the
API-call budget per event type, and a list of SIMKL API quirks that cost real time to discover.

SIMKL publishes its API reference in an agent-readable form at <https://api.simkl.org/llms.txt>.
That is the authority for everything under `src/simkl/` and `src/sources/` — the PIN device flow,
`/sync/activities`, `/sync/all-items`, the calendar files and the per-title film lookups — and it
states the rate-limit rules the polling intervals here are derived from. Note that `types.ts` is
still written from live responses rather than from the docs: the two disagree in several places,
and the live shape is the one that ships.
