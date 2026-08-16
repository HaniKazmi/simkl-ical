# Architecture

How the service is put together. The rules that follow from it are in [AGENTS.md](AGENTS.md); what
it does for its user is in [README.md](README.md).

Two data sources that are useless alone, joined on the SIMKL id:

```
data.simkl.in/calendar/v2/*.json   (public CDN, airdates, whole database)  ─┐
api.simkl.com/sync/all-items        (OAuth, your library, no dates)         ─┤─ join ─→ ICS
api.simkl.com/movies/{id}          (per-film release dates)                ─┘
```

One poll drives two independent consumers. `Orchestrator` owns the SIMKL library — the only input
both halves need — plus the timers and `/healthz`, and hands the library to `Feed` and `SheetSync`
as peers. Neither knows the other exists.

**Requests never trigger a fetch.** A client polling hard cannot amplify into SIMKL traffic, and a
SIMKL outage degrades to a stale feed rather than an empty one.

---

## The two flows

### The feed — FETCH → JOIN → RENDER → SAVE

The library is not in here: it arrives from the poll below, already fetched. The feed fetches only
what the poll does not.

| Step | What happens | Upstream calls |
| --- | --- | --- |
| FETCH airdates | The rolling file per type, plus one monthly archive per month the grace window reaches. Archives merge first, rolling last, so the freshest wins on overlap. | `GET data.simkl.in/calendar/v2/{tv,anime}.json` and `…/{year}/{month}/{type}.json` — conditional, mostly `304` |
| FETCH films | Per title, because the CDN's `movie_release.json` covers a rolling 33-day window with placeholder times, so a release six months out never appears in it. | `GET /movies/{id}?extended=full`, one per plan-to-watch film, 4 at a time |
| JOIN | Calendars × library × releases → events | none |
| RENDER | Events → an ICS string | none |
| SAVE | The rendered feed to disk, and back on boot | none |

What the join encodes: `completed` counts as watching, because SIMKL marks an ongoing show completed
the moment you catch up. Plan-to-watch contributes premieres only. Aired episodes linger for
`GRACE_DAYS`, deliberately *not* filtered by watch state — the feed records what aired. Anime is a
separate SIMKL type rather than a genre, and carries no season number.

### The sheet sync — INDEX → READ → PARSE → PLAN → GUARD → BUILD → APPLY → VERIFY → ROLLBACK

Inert unless `SHEET_ID` **and** a Google credential are both set. It writes exactly three things —
a season row's `Episode` count, a season row's `End` date, and a show row's `Status` — and inserts
a season row when a new season is started. Nothing else, ever.

| Step | What happens | Upstream calls |
| --- | --- | --- |
| INDEX | The library, reduced to what was watched per title. An empty index ends the run here, before anything is read. | none — the library is already in hand |
| READ | The tab, and the catalogue of every title whose watch time moved | `GET spreadsheets/{id}` (grid, field-masked); `GET /tv/episodes/{id}` and `GET /tv/{id}` or `/anime/{id}` per moved title |
| PARSE | Snapshot → blocks | none |
| PLAN | Grid + library + catalogue → a plan | none |
| GUARD | Re-derive every claim the plan made against the snapshot it was built from. Refuses whole; never trims. | none |
| BUILD | The plan → one ordered batch | none |
| APPLY | One atomic `batchUpdate`, led by a `duplicateSheet` snapshot of the tab | `POST {id}:batchUpdate`; `GET spreadsheets/{id}?fields=sheets.properties` if the reply is lost |
| VERIFY | Re-read and diff against what was planned | `GET spreadsheets/{id}` again |
| ROLLBACK | Only when verify fails: delete the inserted row, re-read, paste the snapshot back | up to 3 more `batchUpdate` plus reads |

`report` mode stops after GUARD and writes nothing — that is the default, and what you point at a
real spreadsheet before the service account has Editor access.

Where a run stopped is `/healthz`'s `sheet.status`; AGENTS.md maps each value to the step that
produced it.

---

## When anything runs, and what it costs

Two timers. Everything else is gated off them, and every gate exists because the call it guards is
expensive or the thing it fetches rarely changes.

| Call | Fires when | Request |
| --- | --- | --- |
| Airdate calendars | calendar timer, **6h** | `GET data.simkl.in/calendar/v2/{tv,anime}.json`, plus `…/{year}/{month}/{tv,anime}.json` per month the grace window reaches — conditional on `If-Modified-Since`, so `304` unless the CDN regenerated |
| Activities gate | library timer, **30m** | `GET api.simkl.com/sync/activities` |
| Library delta | a status timestamp moved in the gate above | `GET /sync/all-items?date_from={watermark − 1s}&extended=full&episode_watched_at=yes&include_all_episodes=yes` |
| Whole library | cold start, or a forced poll | the same call without `date_from` |
| Membership set | `removed_from_list` moved | `GET /sync/all-items?extended=simkl_ids_only` — ids alone, to diff against |
| Film release date | a film is new, undated, or dated inside **30 days**; at most once per **24h** each | `GET /movies/{id}` — 4 at a time |
| A title's episode list | that title's `lastWatchedAt` moved, else after **24h** | `GET /tv/episodes/{id}` |
| A title's status | same trigger as its episode list | `GET /tv/{id}`, or `/anime/{id}` for a cour |
| Read the spreadsheet | start of every sheet-sync run, and again to verify a write | `GET sheets.googleapis.com/v4/spreadsheets/{id}?ranges='Sheet1'&fields=…` |
| Write the spreadsheet | a plan passed the guard, in `apply` mode only | `POST …/spreadsheets/{id}:batchUpdate` |
| List the tabs | after a write, to find or sweep the snapshot tab | `GET …/spreadsheets/{id}?fields=sheets.properties(sheetId,title)` |
| Google access token | within **5 minutes** of expiry | `POST oauth2.googleapis.com/token` — a locally-signed RS256 assertion |
| SIMKL login | `npm run login` only, never from the service | `GET /oauth/pin`, then `GET /oauth/pin/{code}` until approved |

Every SIMKL request also carries `client_id`, `app-name` and `app-version` as query parameters and
a `simkl-api-key` header; authenticated ones add a bearer token.

**`/sync/activities` is what makes this cheap.** It returns a last-modified timestamp per category,
so a poll where nothing moved costs exactly **one request** — the gate itself. Two signatures come
off it, and they answer different questions. `librarySignature` is the five status timestamps across
all three categories, and it decides whether to pull; `playback` and `rated_at` are deliberately
excluded, or a scrobbler reporting progress would pull a delta that renders byte-identical output.
`removalStamps` is `removed_from_list` per category, and `movedRemovals` names the ones that moved —
a removal moves that timestamp and produces no delta record at all, so the pull is gated on it. Which
category moved also decides what may be deleted: an empty category is omitted from the response, so a
payload that lost one is the same bytes as a category the user emptied, and only a category that
reported a removal is reconciled against. A response that would still drop most of such a category is
refused and answered with a full pull, which is authoritative where the diff can only guess.

`activities.all` is neither of those. It is the **watermark** — what goes back out as `date_from` —
and it rolls `playback` up with everything else, which is exactly why it cannot also be the trigger.

Three things sit on their own clocks because **nothing in the library moves when they change**, so
there is no signature to gate on: a studio delaying a film, a network renewing a show, and a token
expiring. Hence the film horizon, the 24h catalogue ceiling, and the 5-minute token margin.

Without the per-title catalogue gate, watching one episode would re-read the catalogue of every
eligible show — about 35 calls for a one-cell edit on a 300-row sheet. With it, a warm run makes
roughly two.

One type-less call returns all three types and every status, so the sheet sync's need for `hold` and
`dropped` — without which "absent from the library" cannot mean *no information* — costs nothing over
what the feed alone would fetch. The cold pull carries roughly 330 completed films the feed never
looks at; they are kept rather than filtered because the membership set the removal diff intersects
against contains them too, and because a film moving `plantowatch → completed` arrives as exactly the
`completed` record a filter would drop, leaving the stale copy behind.

README has the same thing cut by user action rather than by call — one request when nothing changed,
two on a cold start.

---

## Where the code lives

Five buckets — `shared/`, `api/`, `feed/`, `sheet/`, `status/` — so the folder a file is in answers two
questions: which half of the project needs it, and is it transport or business logic. Each half is
an `io/` shell around a pure core numbered in pipeline order, so a directory listing is the flow
above. AGENTS.md has the file-by-file map; layering runs downward only.

Two things inside `api/` are shared, and both for the same reason: they encode a rule that drifts
silently when copied. Retry timing — a blank `Retry-After` is not zero, and the header may be an
HTTP date. And the per-title lookup pool — an account-level failure is not a fact about the title
that hit it, and a 401 filed as "this title is unavailable" makes an expired token look like a
hundred deleted films. The two clients stay separate, because base URL, auth and status mapping are
exactly what differs between them.

---

## Invariants

- **One owner per piece of state.** The library is *passed* to `Feed`, never stored there, so a poll
  cannot end up with two copies that disagree — which matters because the merge and the removal diff
  each return a new Map, replacing the library in one assignment. Each half owns its own error slots,
  so the two timers *cannot* clear each other's failures.
- **A calendar render reads the library after its own fetch, not before.** The fetch is several MB;
  the library poll runs throughout; and this render is queued last, so a value captured before the
  fetch would overwrite the poll's correct render and stand until the next refresh.
- **The feed is replaced only when both halves are present**, so a partial refresh never overwrites
  a complete feed loaded from disk. Renders serialise through one promise chain — both timers end
  there, and at the default intervals every calendar tick lands on a library poll, so overlapping
  runs are the norm rather than an edge case.
- **Nothing in the refresh path may be fatal.** Failures land in a per-subsystem slot and `/healthz`
  reports why. The sheet's error is excluded from both `ok` and `problems`: `/healthz` is the
  container healthcheck and the CI smoke test, and a frozen sync must not restart the container.
- **`localDate()` is the highest-risk conversion here.** Airdates are UTC instants; `iso.slice(0, 10)`
  is wrong for ~19% of entries in `America/New_York`. Never slice. The archive window is enumerated
  in the viewer's zone for the same reason: counting it in UTC loses up to a day of grace near a
  month boundary, and the entry then passes the join's filter while living in an archive nothing
  fetched.
- **The library says `ids.simkl`, the calendar says `simkl_id`.** `itemSimklId` bridges them; that
  is the entire join.
- **One record per id, and `item.status` is what it says.** A delta returns each changed item once
  carrying its current status, and the records are complete rather than partial patches — a changed
  show arrives with its full `seasons[]` — so a merge is a plain upsert and a move is a replacement.
  Nothing can hold two copies of a title that disagree. `completed` counts as airing deliberately:
  SIMKL marks an ongoing show completed the moment you catch up, which is when its next season
  matters most.
- **Removals are the exception, and are in no delta.** `removed_from_list` says one happened but not
  what went, so the library is intersected with an `extended=simkl_ids_only` pull. A response that
  would drop most of the library is refused and retried rather than applied: a truncated response and
  a cleared account are the same bytes, and applying the wrong one empties the feed.
- **UIDs are derived, never random**, or clients duplicate events instead of updating them.
- **Three files are persisted**, all 0600 through `writeFileAtomic`: `token.json`, `feed.ics`, and
  `sheet-runs.json`. The third is **observational, never control** — written by the sheet half and
  read only by the status page. *Nothing in `src/` may read it to decide what to do*: not to skip a
  run, not to arm a retry, not to remember a freeze. No control state outlives the process, so a
  restart still resyncs everything, because no decision consults it. The delta watermark is held the
  same way — in memory only — so a restart is a cold start: two library requests, plus one
  `/movies/{id}` per plan-to-watch film.
- **Every numeric setting is clamped** rather than validated fatally: a running feed beats a
  container that will not boot.

## No build step

Node strips the types. There is no `dist/`, no bundler; the code that runs is the code you read, and
`tsc` is a checker only. So: **erasable syntax only** (no enums, namespaces, parameter properties or
decorators — `erasableSyntaxOnly` makes them compile errors), **import specifiers carry the real
extension**, and **type-only imports must say `import type`**.

---

# The sheet's sharp edges

Everything above is the shape. This is the part where being wrong corrupts a hand-maintained
spreadsheet, and it is why the sync is as paranoid as it is.

## Reading a sheet nobody designed for a machine

The structure is implicit, so parsing fails closed rather than guessing.

- **A row with `Show` filled starts a block**; every row after it belongs to that block.
- **Columns are resolved by header, never position** — they get rearranged. Missing, renamed or
  duplicated writes nothing at all: a duplicate makes "which column is `Episode`" unanswerable, and
  the wrong answer is a real edit to the wrong cell.
- **Which SIMKL entry a row means is decided by where its id sits**, never by `Type`. A season row's
  own id wins; a blank one inherits the show row's. Both exceptions exist in the live sheet, and
  independently: one title carries ids in both places, another only on a season row despite reading
  `Type=show`.
- **`Episode` on a season row is a count, not an episode number**, because `Length = Episodes ×
  Episode`. The two coincide for in-order viewing — which is exactly why writing the highest episode
  number would survive testing and corrupt every total.
- **A non-blank `End` closes the row even if it does not parse as a date.** A hand-typed `TBD` is not
  a missing end date.

## What it refuses to write

- **Never a formula, and never a show row except `Status`.** Every derived cell on a show row is a
  self-sizing roll-up over the season rows beneath it. That makes the show row read-only, makes an
  insert need no formula rewriting, and is why the rule is unconditional.
- **A season is complete only when `aired === total` AND `watched >= total`.** "Every aired episode
  watched" dates a season that is still running, and a dated season is never revisited.
- **Nothing without recent watch activity** (`SHEET_SINCE_DAYS`, 90 by default). That cut-off is what
  stops any run retro-editing years of history; a dormant sheet produces zero edits.
- **Missing data fails closed.** No episode list means no end date — and no `Status` either, rather
  than falling through to the anime reading of the not-aired counter, which spans the whole show.
- **Exactly one row per run.** Plan indices are pre-write while `insertDimension` applies
  cumulatively, so a second insert would land a row high and verify would make the same unshifted
  assumption. An invariant of how requests are built, not a budget: a second pending season is
  reported and taken by the next poll.

## The write

The whole cycle happens inside one poll, so what was planned and what was written describe the same
grid. A snapshot older than 120s is discarded and the cycle restarts **from the read**.

- **Reads use `spreadsheets.get` with grid data; writes use `batchUpdate`.** The read gives
  `userEnteredValue` (the only definitive formula test) and `effectiveValue` (true date serials).
  The write is atomic, ordered, leaves formats alone, and sends `{numberValue: 46265}` rather than a
  date string that `08/15` and `15/08` misparse identically for twelve days a month.
- **The read carries a `fields` mask.** Unmasked it returns every cell's format block: 45 MB against
  2.4 MB, measured, for identical values. A field mask supersedes `includeGridData`, so asking for
  `data` is what returns the grid at all.
- **A write is never retried.** `batchUpdate` is atomic but not idempotent — a retried
  `insertDimension` inserts two rows. Reads opt into retry; writes never do.
- **Request order is load-bearing**: edits descending, then the `insertDimension`, then the new row's
  fill — which shares a row index with the insert, so any "edits before inserts" rule overwrites a
  real row.
- **The snapshot rides the same batch.** `duplicateSheet` leads it, so there is no state where the
  sheet changed but nothing recorded what it looked like. Server-side, so a 1600-row copy costs no
  transfer. Named versions would be the obvious alternative and are reachable from no API at all.
- **A clean run leaves no snapshot; a frozen one renames its out of reach.** `_sync-backup-…` tabs
  are swept once a write verifies. But `frozen` is process state, so a restart forgets that a run
  told the user to repair from a particular tab — hence the freeze path renames it to
  `_sync-REPAIR-…` first. That rename is the only write here allowed a second attempt, because
  renaming to a fixed title is idempotent and nothing else is.

## Verify, and the edge that makes it hard

**The diff is on `userEnteredValue`, never `effectiveValue`.** Writing one cell recalculates five
formulas, so `effectiveValue` moves in cells nobody wrote.

`userEnteredValue` changes only when someone writes — **while the grid holds still**. An insert is
the exception, and it is the sharpest edge in the subsystem: Sheets rewrites the relative A1
references in every formula the insert shifts, so `=I609*F609` becomes `=I610*F610` with nobody
typing anything. Compared as text that is ~1500 unplanned changes, and the rollback a false positive
invites writes the pre-insert text back alongside the delete that shifts it again — one row off. The
check meant to catch corruption becomes the thing that causes it. So across an insert a formula is
checked for still *being* a formula; literals stay strictly compared, and they are what actually
catches a misalignment, because every literal on a season row moves with the row.

Two questions decide whether a rollback happens, and both are answered from the **planned writes**
rather than the shape of the grid:

- *Did anything land?* `batchUpdate` is atomic, so none of them being present means the batch never
  went out. Row growth cannot answer it — an atomic failure on a plan containing an insert leaves
  the count unchanged, and a concurrent human insert moves it without any of ours landing. Getting
  that wrong sends the rollback looking for a snapshot tab that rode the same failed batch: a
  permanent freeze over an untouched sheet.
- *Which rows may be deleted?* Only ones where every planned cell is present at exactly the planned
  index. `insertDimension` lands where it is told, so anything less is a pre-existing row.

**Rollback is not partial-write recovery** — `batchUpdate` leaves no half-applied state. It exists
for the case where *the plan was wrong*, and runs in separate batches: check a snapshot exists,
delete the inserted row, re-read, then paste the snapshot back at a zero offset. Deleting first is
what shrinks the grid, and it undoes the reference rewriting for free, since Sheets rewrites on the
way out exactly as it did on the way in.

The wholesale paste has one accepted cost: a human edit landing in the seconds-wide window between
the batch and the verify read is inside the pasted range, so it is reverted too. Closing that needs
a per-cell revert — the mechanism a one-row misalignment lives in — which is not worth it for a
window this narrow. For the same reason, a landed write whose snapshot cannot be found **freezes**
rather than putting cells back individually.

## Catalogue retention

`SheetSync` holds catalogue results across polls, stamped with the `lastWatchedAt` each id had at
the time, and re-requests only ids whose value moved.

**The retention lives in `SheetSync`, not in `io/catalogue.ts`** — the source fetches, the caller
decides when, exactly as `io/movies.ts` and `Feed` divide it. A TTL cache under the source would
serve a stale episode list for a show the caller just decided to refresh *because* it changed. It
keeps only what the planner reads — per-season shapes, `status`, `runtime` — so per-episode
descriptions and images do not accumulate for the life of the process.

Upstream API references, and what they do not offer, are at the end of [AGENTS.md](AGENTS.md).
