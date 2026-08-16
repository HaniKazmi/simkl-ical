# Architecture

How the service is put together, and why. The rules that follow from it are listed in
[AGENTS.md](AGENTS.md); what the service does for its user is in [README.md](README.md).

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

- `src/backoff.ts` — retry timing and the `HttpError` base. Shared because `retryDelayMs` encodes
  two things that are easy to get subtly wrong (a blank `Retry-After` is not zero; the header may
  be an HTTP date) and a second copy means fixing one and not the other.
- `src/simkl/`, `src/sheets/` — transport, one per upstream API. Each owns its base URL, auth,
  retryable statuses and status-to-error mapping; those are what genuinely differ, so the request
  loops stay separate rather than collapsing into one parameterised one.
- `src/simkl/pool.ts` — bounded-concurrency per-title lookups. Shared by `movies.ts` and `shows.ts`
  for the three-way split of an error: retryable, gone, or account-level and therefore not a fact
  about this title at all. A second copy of that last clause drifts silently — a 401 filed as "this
  title is unavailable" makes an expired token look like a hundred deleted films.
- `src/sources/` — one module per upstream. `calendar.ts` (CDN, conditional GET, in-process cache,
  monthly archives), `library.ts` (authenticated lists, activities gating), `movies.ts` (per-title
  release dates), `shows.ts` (per-title episode lists and status), `sheet.ts` (read and write one
  tab).
- `src/join.ts` → `src/ics.ts`, and all of `src/sheet/` — pure. They take options with config-backed
  defaults rather than reading `config` mid-body, so they stay testable.
- `src/server.ts` — Fastify, two routes, no state of its own.

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
  and `/healthz` reports why. `errors.sheet` is reported but deliberately excluded from `Health.ok`:
  `/healthz` is the container healthcheck and the CI smoke test, and a frozen sheet sync must not
  restart the container or fail a deploy.
- **Only `feed.ics` and `token.json` are persisted.** No control state outlives the process, so a
  restart always resyncs. Both are written 0600 through `writeFileAtomic`.
- **UIDs are derived, never random.** A fresh UID each render makes clients duplicate events
  instead of updating them.
- **`localDate()` is the highest-risk conversion in the project.** Airdates are UTC instants;
  `iso.slice(0, 10)` is wrong for ~19% of entries in `America/New_York`. Never slice.
- **The library says `ids.simkl`, the calendar says `simkl_id`.** `itemSimklId` bridges them; that
  is the entire join.
- **List membership is not status.** SIMKL reports a move against the destination list only, and
  `listSignature` advances only for the destination — so a show moved to `dropped` or `hold` sits
  in `watching` indefinitely and nothing ever refetches it out. `item.status` is the field that
  says which list is current; `idSet` and `indexLibrary` both defer to it. `completed` is
  deliberately left lingering: everything it contributes is already dated and ages out of the
  grace window on its own, and SIMKL marks an ongoing show completed the moment you catch up.
- **Films do not come from the CDN calendar.** `movie_release.json` covers a rolling 33-day window
  with placeholder times, so films are resolved per title and re-read daily on their own clock —
  a studio delay produces no library activity to gate on.
- **The archive window is enumerated in the viewer's zone**, because the join's cutoff is
  `localDate(now) - graceDays`. Counting it in UTC instead loses up to a day of grace in any
  behind-UTC zone near a month boundary: the entry passes the join's filter and lives in an archive
  nothing fetched.
- **`config` is a process-wide singleton** built by `buildConfig(env)`. Every numeric setting is
  clamped rather than validated fatally: a running feed beats a container that will not boot.

## Domain rules encoded in the join

`completed` is treated as watching (SIMKL marks an ongoing show completed once you're caught up).
Plan-to-watch contributes premieres only. Aired episodes linger for `GRACE_DAYS` and that lingering
is deliberately *not* filtered by watch state. Anime is a separate SIMKL type, not a genre, and
carries no season number. A grace window past two days pulls monthly archives, whose URLs use an
**unpadded** month.

---

# The sheet sync

A second consumer of the same poll, structurally separate from the feed: `src/sheets/` (transport),
`src/sheet/` (pure), `src/sheet-sync.ts` (the protocol). Inert unless `SHEET_ID` **and** a Google
credential are both supplied — a target with no credential stays off rather than filing an ENOENT
once per poll.

It writes exactly three things — a season row's `Episode` count, a season row's `End` date, and a
show row's `Status` — and inserts a season row when a new season is started. Nothing else, ever.

```
library (already fetched)  ─┐
/tv/episodes/{id}           ─┤─ plan ─→ guard ─→ batchUpdate ─→ verify ─→ (rollback)
/tv/{id} | /anime/{id}      ─┘
```

## Reading the sheet

The spreadsheet is hand-maintained and its structure is implicit, so parsing fails closed rather
than guessing.

- **A row with the `Show` column filled starts a block**; every row after it belongs to that block
  until the next one.
- **Columns are resolved by header, never by position** — they get rearranged. A missing, renamed
  or duplicated label writes nothing at all, because a duplicate makes "which column is `Episode`"
  unanswerable and the wrong answer is a real edit to the wrong cell.
- **Which SIMKL entry a row belongs to is decided by where its id sits**, never by `Type`. A season
  row's own id wins; a blank one inherits the show row's. Both exceptions exist in the live sheet
  and are independent of each other — one title has ids in both places, another only on a season
  row despite reading `Type=show`.
- **`Episode` on a season row is a count, not an episode number**, because `Length = Episodes ×
  Episode`. The two coincide for in-order viewing, which is exactly why writing the highest episode
  number would survive testing and corrupt every total.
- **A non-blank `End` closes the row even if it does not parse as a date.** A hand-typed `TBD` is
  not a missing end date, and treating it as one would overwrite the note with a serial.

## What it will and will not write

- **The sheet's own show-row formulas do the roll-ups.** Every derived cell on a show row (`Season`,
  `Episode`, `End`, `Episodes`, `Length`) is a self-sizing formula over the season rows beneath it.
  That makes the show row read-only to the sync, makes an insert need no formula rewriting, and is
  why the never-write-a-formula rule is unconditional.
- **A season is complete only when `aired === total` AND `watched >= total`.** "Every aired episode
  watched" dates a season that is still running, and a dated season is never revisited.
- **Nothing is touched without recent watch activity.** The cut-off (`SHEET_SINCE_DAYS`, 90 by
  default) is what stops any run retro-editing years of history; a dormant sheet produces zero
  edits.
- **Missing data fails closed.** A season with no episode list gets no end date, and — for the same
  reason — a live-action show with no episode list gets no `Status` either, rather than falling
  through to the anime reading of the not-aired counter, which spans the whole show.
- **Exactly one row is added per run.** Plan indices are pre-write while `insertDimension` requests
  apply cumulatively, so a second insert would land a row high and `verify` would make the same
  unshifted assumption. It is an invariant of how requests are built, not a budget: a second
  pending season is reported and taken by the next poll.

## The write protocol

The whole cycle — read, plan, guard, write, verify — happens inside one poll, so what was planned
and what was written describe the same grid. A snapshot older than 120s is discarded and the cycle
restarts **from the read**, not from the write.

- **Reads use `spreadsheets.get` with grid data, writes use `batchUpdate`.** The read gives
  `userEnteredValue` (the only definitive formula test) and `effectiveValue` (true date serials);
  the write is atomic, ordered, leaves formats alone, and sends `{numberValue: 46265}` rather than a
  date string that `08/15` and `15/08` misparse identically for twelve days a month.
- **The read carries a `fields` mask naming exactly those two.** Unmasked, the response is every
  cell's full format block for 1644 rows — 45 MB against 2.4 MB, measured, for identical values.
  A field mask supersedes `includeGridData`, so asking for `data` is what returns the grid at all.
- **A write is never retried.** `batchUpdate` is atomic but not idempotent — a retried
  `insertDimension` inserts two rows. Reads opt into retry; writes never do.
- **Request order is load-bearing**: edits to pre-existing rows (descending), then the
  `insertDimension`, then the new row's fill — which shares a row index with the insert, so any
  "edits before inserts" rule overwrites a real row.
- **The write batch snapshots the tab first.** `duplicateSheet` leads the same atomic batch, so
  there is no state in which the sheet changed but nothing recorded what it looked like. It is
  server-side, so a 1600-row copy costs no data transfer. Named versions were the obvious
  alternative and are reachable from no API at all.
- **One snapshot tab survives, and only one.** `frozen` is process state, so a restart forgets
  that a run told the user to repair from a particular tab — and a clean write sweeping the lot
  would then destroy the only pre-corruption copy. Everything older than the newest goes on each
  clean run, because each is a full tab copy against a 10M-cell ceiling for the spreadsheet.

## Verification, and what it cost to learn

**The diff is on `userEnteredValue`, never `effectiveValue`.** Writing one cell recalculates five
formulas, so `effectiveValue` moves in cells nobody wrote and cannot be compared.

`userEnteredValue` changes only when someone writes — **while the grid holds still**. Inserting a
row is the exception, and finding that out cost a corrupted sheet: Sheets rewrites the relative A1
references in every formula the insert shifts, so `=I609*F609` becomes `=I610*F610` with nobody
having typed anything. Verify read ~1500 of those as unplanned changes, and the rollback then wrote
the pre-insert text back *and* deleted the row in one batch — so the delete rewrote that text again
on the way out, one row off. A false positive became the exact corruption the design exists to
prevent.

So across an insert a formula is checked for still *being* a formula rather than for its text.
Literals stay strictly compared, and they are what catches a misalignment — every literal on a
season row moves with the row.

**Rollback is not partial-write recovery**; `batchUpdate` leaves no half-applied state. It exists
for the case where *the plan was wrong*, and it runs in separate batches: check a snapshot exists,
delete the inserted row, re-read, then paste the snapshot back over the tab at a zero offset.
Deleting first is what shrinks the grid — a paste overwrites a range, it cannot remove a row — and
it also undoes the reference rewriting for free, since Sheets rewrites on the way out exactly as it
did on the way in. The paste is one server-side request whose cost does not grow with the number of
cells that changed, and it cannot be off by a row.

Two questions decide whether any of that happens, and both are answered from the **planned writes**
rather than from the shape of the grid. *Did anything land?* — `batchUpdate` is atomic, so none of
them being present means the batch never went out, and inferring it from row growth instead turned
a single transient 503 on a plan containing an insert into a permanent freeze over an untouched
sheet. *Which rows may be deleted?* — only ones where every planned cell is present at exactly the
planned index. `insertDimension` lands where it is told, so anything less is a pre-existing row, and
a grid confused enough to disagree restores wholesale or freezes rather than guessing.

The wholesale restore has one accepted cost: a human edit landing in the seconds-wide window
between the batch and the verify read sits inside the pasted range, so it is reverted along with
ours, and the confirming verify reports a clean rollback. A per-cell revert would close that window
and was rejected as too fragile to be worth it — it is the mechanism that misaligned the sheet once
already.

If the write landed and no snapshot can be found, the sync **freezes** rather than falling back to
putting cells back individually — that is the mechanism that produced the misalignment once, and
running it in the least-exercised state there is would be worse than stopping.

## Catalogue lookups

`/sync/activities` resolves to a list and never to a show, so a poll knows only that *something*
moved. Without a second gate, watching one episode re-reads the catalogue of every eligible show —
roughly 28 calls for a one-cell edit.

`SheetSync` retains results across polls and stamps each id with the `lastWatchedAt` it held at the
time; `planLookups` re-requests only ids whose value moved. Watch activity is the right trigger
because it is the trigger for everything the sync writes: a season cannot become complete without
being watched. A 24h ceiling backstops the one thing that changes with no library activity —
`/tv/{id}` status flipping on a renewal — and is daily for the same reason `movieRefreshMs` is.

**The retention lives in `SheetSync`, not in `sources/shows.ts`.** The source fetches; the caller
decides when, exactly as `movies.ts` and `FeedState` divide it. A TTL cache under the source would
serve a stale episode list for a show the caller just decided to refresh *because* it changed. It
also stores only what the planner reads — per-season shapes, `status`, `runtime` — rather than the
raw payloads, so per-episode descriptions and images do not accumulate for the life of the process.

## Further reading

`README.md` has two collapsed sections worth reading before touching the refresh logic: the
API-call budget per event type, and a list of SIMKL API quirks that cost real time to discover.
Upstream API references, and what they do not offer, are listed at the end of
[AGENTS.md](AGENTS.md).
