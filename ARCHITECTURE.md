# Architecture

How the service is put together. The rules that follow from it are in [AGENTS.md](AGENTS.md); what
it does for its user is in [README.md](README.md).

Two data sources that are useless alone, joined on the SIMKL id:

```
data.simkl.in/calendar/v2/*.json   (public CDN, airdates, whole database)  ─┐
api.simkl.com/sync/all-items        (OAuth, your library, no dates)         ─┤─ join ─→ ICS
api.simkl.com/movies/{id}          (per-film release dates)                ─┘

api4.thetvdb.com/v4/series/{id}/episodes/official   (per-episode runtimes)  ─→ the sheet only
api.themoviedb.org/3/movie/{id}                     (a film's genres, certificate, dates, crew, backdrop) ─→ the sheet only

api.themoviedb.org/3/movie/{id}/images              (a film's backdrops)     ─┐
api4.thetvdb.com/v4/series/{id}/artworks            (a show's posters)       ─┤─ the artwork page only
storage.googleapis.com                              (where a pick is put)    ─┘
```

The fourth and fifth are not part of the join. TVDB answers one question the other three cannot —
how long a season's episodes are — and only for a season the sheet is about to close. TMDB answers
the eight columns a new row on the sheet's films tab needs and SIMKL does not hold, once per film,
on the poll that adds its row.

One poll drives two independent consumers. `Orchestrator` owns the SIMKL library — the only input
both halves need — plus the timers, and hands the library to `Feed` and `SheetSync` as peers.
Neither knows the other exists. The orchestrator's `snapshot()` is the one export of state; both
`/healthz` and the status page project from it, and `health.ts` holds both definitions of healthy.

**Requests never trigger a fetch** — on the feed, `/healthz` and the status page. A client polling
hard cannot amplify into SIMKL traffic, and a SIMKL outage degrades to a stale feed rather than an
empty one. The artwork page is the stated exception: it is a tool, not a projection, and a pick
is a request that downloads, uploads and writes. What bounds it is the token, an index cache, and
that none of its upstreams is SIMKL — the one per-title SIMKL read it can make, a show's TVDB id,
happens once per opened row and never at index time.

---

## The two flows

### The feed — FILMS → JOIN → RENDER, around io/

The library is not in here: it arrives from the poll below, already fetched. The feed fetches only
what the poll does not.

| Step | What happens | Upstream calls |
| --- | --- | --- |
| fetch airdates | The rolling file per type, plus one monthly archive per month the grace window reaches. Archives merge first, rolling last, so the freshest wins on overlap. | `GET data.simkl.in/calendar/v2/{tv,anime}.json` and `…/{year}/{month}/{type}.json` — conditional, mostly `304` |
| fetch films | Per title, because the CDN's `movie_release.json` covers a rolling 33-day window with placeholder times, so a release six months out never appears in it. | `GET /movies/{id}?extended=full`, one per plan-to-watch film, 4 at a time |
| FILMS | Which of a film's many dates count — up to two, its cinema date and its home date — and when one is worth re-reading | none |
| JOIN | Calendars × library × releases → events | none |
| RENDER | Events → an ICS string; saved to disk, and loaded back on boot | none |

What the join encodes: `completed` counts as watching, because SIMKL marks an ongoing show completed
the moment you catch up. Plan-to-watch contributes premieres only. Aired episodes linger for
`GRACE_DAYS`, deliberately *not* filtered by watch state — the feed records what aired. A film
contributes an event per date it has, each cut off on its own. Anime is a separate SIMKL type rather
than a genre, and carries no season number.

### The sheet sync — INDEX → READ/PARSE → (PLAN ⇄ FETCH) → GUARD → BUILD → APPLY → VERIFY → ROLLBACK

Inert unless `SHEET_ID` **and** a Google credential are both set. It writes exactly six things —
a season row's `Episode` count, its `Start` and `End` dates, its `Episodes` runtime *into a blank
cell only*, a show row's `Status`, and a season row's `Status`, which dates that `Episode` count and
moves only when it does, until `End` arrives to say it better — and inserts a season row when a new
season is started. Nothing else, ever. The runtime additionally needs `TVDB_API_KEY`; without it the
other five behave exactly as they do with it.

`Start` and `End` are the two that **follow SIMKL**, the only two written to a row already dated,
and the only two that ignore the activity window — a corrected watch date is a recent change that
moves no watch timestamp, so a recency gate cannot see it, and the baseline is what keeps a dormant
sheet quiet instead. A write needs the value to have moved away from what `io/baseline.ts` recorded — not away
from what the cell holds, which may have disagreed since before the sync first ran. A season not yet
recorded is recorded and left alone, so the feature only ever acts on changes from the point it was
switched on.

| Step | What happens | Upstream calls |
| --- | --- | --- |
| INDEX | The library, reduced to what was watched per title. An empty index ends the run here, before anything is read. | none — the library is already in hand |
| READ + PARSE | The tab, snapshot → blocks | `GET spreadsheets/{id}` (grid, field-masked) |
| PLAN ⇄ FETCH | The planner returns a plan **plus what it still needs**; the sync fetches the demands, folds them into the catalogue store, and re-plans until a pass demands nothing new — catalogues first, then the runtimes the catalogues reveal to be worth asking about | `GET /tv/episodes/{id}` and `GET /tv/{id}` or `/anime/{id}` per moved title; `GET api4.thetvdb.com/v4/series/{id}/episodes/official?season={n}` per closing season |
| GUARD | A checklist of named rules re-deriving the plan's claims against the snapshot it was built from. Refuses whole; never trims. | none |
| BUILD | The plan → one ordered batch | none |
| APPLY | One atomic `batchUpdate`, led by a `duplicateSheet` snapshot of the tab | `POST {id}:batchUpdate`; `GET spreadsheets/{id}?fields=sheets.properties` if the reply is lost |
| VERIFY | Re-read and diff against what was planned | `GET spreadsheets/{id}` again |
| ROLLBACK | Only when verify fails: delete the inserted row, re-read, paste the snapshot back | more `batchUpdate` plus reads |

The plan-fetch loop is the load-bearing shape: what to fetch and what to write are one computation,
so a season the planner waits on is by construction a season the same pass demanded. A snapshot
older than 120s is discarded and the cycle restarts from the read. That re-plan re-issues no
lookup the run has already made, and asks TVDB for nothing at all: a throttled season can spend a
minute obeying `Retry-After`, which would age the fresh snapshot in its turn. Those rows stay open
and the next poll takes them.

`report` mode stops after GUARD and writes nothing — that is the default, and what you point at a
real spreadsheet before the service account has Editor access.

Where a run stopped is `/healthz`'s `sheet.status`; AGENTS.md maps each value to the step that
produced it.

#### The films tab

The same poll keeps a second, flat tab current — one row per film, no blocks, no formulas — through
a sibling numbered core in `src/sheet/movies/`. It is inert without `TMDB_API_KEY`: eight of the
tab's fourteen columns come from TMDB, and a row inserted with those blank is worse than no row.
Three columns follow SIMKL for the life of a row — `Watch Date`, `Score`, `Runtime` — off the
library alone and against the same baseline file; the rest are written once when the row is
created, one row per run, below the last row the tab holds.

`sync.ts` runs both tabs through one loop. What the loop holds — the read, the freshness budget,
the report/refuse/apply branches, the freeze latch, the journal — holds no rule about what may be
written, so it exists once; what differs between the tabs is how a grid is parsed, planned, guarded,
described and verified, and each half supplies those as a `TabSpec`. The shows half runs first,
and what it *sent* is charged against the films half's budget, because `SHEET_MAX_EDITS` bounds a
poll rather than a tab. A snapshot tab is named after the tab it copies and a sweep takes only its
own, so a films write verifying clean cannot delete the copy of `Sheet1` a failed show write left
for the operator.

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
| Film release date | a film is new, undated, or its **earliest** date is inside **30 days**; at most once per **24h** each. A film out of cinemas is therefore asked daily, which is what lands its streaming date the day SIMKL learns it | `GET /movies/{id}` — 4 at a time |
| A title's episode list | that title's `lastWatchedAt` moved, else after **24h** | `GET /tv/episodes/{id}` |
| A title's status | same trigger as its episode list | `GET /tv/{id}`, or `/anime/{id}` for a cour |
| A season's episode lengths | that season is completing with a blank runtime cell, or has finished airing on the run that adds its row — then never again | `GET api4.thetvdb.com/v4/series/{id}/episodes/official?season={n}` — one call is one whole season |
| TVDB access token | first runtime lookup, then every **20 days**, or after any `401` | `POST api4.thetvdb.com/v4/login` |
| A film's TMDB record | the film is completed and has no row on the films tab; at most **8** per run, and none once the run has chosen the one row it inserts — the rest are the next poll's; never again once answered, for the life of the process | `GET api.themoviedb.org/3/movie/{tmdb}?append_to_response=release_dates,credits,images` — 4 at a time, bearer token from config |
| Read the spreadsheet | start of every sheet-sync run, per tab, and again to verify a write | `GET sheets.googleapis.com/v4/spreadsheets/{id}?ranges='Sheet1'&fields=…`, and the same for the films tab |
| Write the spreadsheet | a plan passed the guard, in `apply` mode only | `POST …/spreadsheets/{id}:batchUpdate` |
| List the tabs | after a write, to find or sweep the snapshot tab | `GET …/spreadsheets/{id}?fields=sheets.properties(sheetId,title)` |
| Google access token | within **5 minutes** of expiry | `POST oauth2.googleapis.com/token` — a locally-signed RS256 assertion |
| SIMKL login | `npm run login` only, never from the service | `GET /oauth/pin`, then `GET /oauth/pin/{code}` until approved |

Every SIMKL request also carries `client_id`, `app-name` and `app-version` as query parameters and
a `simkl-api-key` header; authenticated ones add a bearer token.

**`/sync/activities` is what makes this cheap.** It returns a last-modified timestamp per category,
so a poll where nothing moved costs exactly **one request** — the gate itself. The signatures it
yields, and why the trigger and the watermark are different timestamps, are `library.ts`'s subject;
the per-title catalogue stamp that keeps a warm sheet run at roughly two calls instead of ~35 is
`3-catalogue.ts`'s.

Three things sit on their own clocks because **nothing in the library moves when they change**, so
there is no signature to gate on: a studio delaying a film, a network renewing a show, and a token
expiring. Hence the film horizon, the 24h catalogue ceiling, and the 5-minute token margin.

One type-less call returns all three types and every status, so the sheet sync's need for `hold` and
`dropped` — without which "absent from the library" cannot mean *no information* — costs nothing over
what the feed alone would fetch. The cold pull carries roughly 330 completed films the feed never
looks at; they are kept rather than filtered because the membership set the removal diff intersects
against contains them too, and because a film moving `plantowatch → completed` arrives as exactly the
`completed` record a filter would drop, leaving the stale copy behind.

---

## Where the code lives

Six buckets — `shared/`, `api/`, `feed/`, `sheet/`, `status/`, `artwork/` — so the folder a file is
in answers two questions: which half of the project needs it, and is it transport or business logic.
Each half is an `io/` shell around a pure core numbered in pipeline order, and the two pages are
layers above both halves that never import each other. AGENTS.md has the file-by-file map;
layering runs downward only.

`api/` is one retrying transport (`http.ts`) under thin per-upstream specs — base URL, credential
headers, and what each status means are exactly what differ between SIMKL, Sheets, Cloud Storage,
TVDB, TMDB and an image CDN, so they are all a spec holds. What a body *is* — JSON to parse, or
bytes to keep — is the one thing the loop delegates, to a consumer that says whether its failure is
the transfer's (retried) or the payload's (terminal). `cdn.ts` is deliberately not on the engine: conditional-GET
plus serve-stale-on-failure is a different protocol from retry-to-success. The lookup pool and the
request log are shared for the same reason the engine is: each encodes a rule that drifts silently
when copied — an account-level failure is not a fact about the item that hit it, and a body that
died mid-download must not surface as a 200 carrying unparseable JSON.

---

## Invariants

- **One owner per piece of state.** The library is *passed* to `Feed`, never stored there, so a poll
  cannot end up with two copies that disagree — the merge and the removal diff each return a new
  Map, replacing the library in one assignment. Each half owns its own error slots, so the two
  timers *cannot* clear each other's failures.
- **A calendar render reads the library after its own fetch, not before.** The fetch is several MB;
  the library poll runs throughout; and this render is queued last, so a value captured before the
  fetch would overwrite the poll's correct render and stand until the next refresh.
- **The feed is replaced only when both halves are present**, so a partial refresh never overwrites
  a complete feed loaded from disk. Renders serialise through one promise chain — both timers end
  there, and at the default intervals every calendar tick lands on a library poll.
- **Nothing in the refresh path may be fatal.** Failures land in a per-subsystem slot and `/healthz`
  reports why. The sheet's error is excluded from both `ok` and `problems`: `/healthz` is the
  container healthcheck and the CI smoke test, and a frozen sync must not restart the container.
- **`plainDateIn()` is the highest-risk conversion here.** Airdates are UTC instants; `iso.slice(0, 10)`
  is wrong for ~19% of entries in `America/New_York`. Never slice. A `Temporal.Instant` cannot become
  a `PlainDate` without being handed a zone, so the type asks the question. The archive window is
  enumerated in the viewer's zone for the same reason: counting it in UTC loses up to a day of grace
  near a month boundary, and the entry then passes the join's filter while living in an archive
  nothing fetched.
- **The library says `ids.simkl`, the calendar says `simkl_id`.** `itemSimklId` bridges them; that
  is the entire join.
- **One record per id, and `item.status` is what it says.** A delta returns each changed item once
  carrying its current status, and the records are complete rather than partial patches, so a merge
  is a plain upsert and a move is a replacement. Nothing can hold two copies of a title that
  disagree.
- **Removals are the exception, and are in no delta.** `removed_from_list` says one happened but not
  what went, so the library is intersected with an `extended=simkl_ids_only` pull. A response that
  would drop most of a category is refused and answered with a full pull: a truncated response and a
  cleared account are the same bytes, and applying the wrong one empties the feed.
- **UIDs are derived, never random**, or clients duplicate events instead of updating them.
- **A sync run and an artwork page write never overlap.** Both hold `withSheetLock` from their
  first read of the sheet to their last verify. The films verifier inspects `Banner`, so a page
  write landing inside a sync run is a cell the sync did not plan, and VERIFY would roll the whole
  tab back over it. The page's write is the one cell on a show row written outside `Status`, and it
  goes through its own checklist rather than the sync's guard: the sync's whitelists are the
  poll's, and widening them for a click is how one rule ends up holding two jobs.
- **A pick uploads before it links, and pre-decides before it uploads.** The object is what the
  site shows and is idempotent, so an upload that outruns a refused link costs nothing; a link
  that outran a failed upload would point at nothing. The pre-decision off the cached cell stops
  the obvious refusals — a formula, a foreign link with no `adopt` — before any bytes move.
- **Three files are persisted**, all 0600 through `writeFileAtomic`: `token.json`, `feed.ics`, and
  `sheet-runs.json`. The third is **observational, never control** — written by the sheet half and
  by the artwork page's link writes, read by the status page and, for the order it lists rows in,
  by the artwork page. *Nothing in `src/` may read it to decide what to do.* No control
  state outlives the process, so a restart still resyncs everything: two library requests, plus one
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

This is the part where being wrong corrupts a hand-maintained spreadsheet. The reasoning lives in
the modules that enforce it — each of these is a pointer plus the facts about the *sheet itself*
that no code can derive.

**The format** (`2-grid.ts` parses it, failing closed rather than guessing):

- A row with `Show` filled starts a block; every row after it belongs to that block. Columns are
  resolved by header, never position.
- Which SIMKL entry a row means is decided by **where its id sits**, never by `Type`: a season row's
  own id wins, a blank one inherits the show row's. Both exceptions exist in the live sheet.
- `Episode` on a season row is a **count**, not an episode number — `Length = Episodes × Episode`,
  and the two coincide for in-order viewing, which is exactly why the wrong one would survive
  testing.
- `Episodes` on a season row is the per-episode runtime as a **day fraction**, minutes ÷ 1440,
  despite the plural. That identity forces the season average to be the arithmetic mean
  (`averageRuntime` in `3-catalogue.ts` carries the arithmetic).
- A non-blank `End` closes the row even if it does not parse as a date: a hand-typed `TBD` is not a
  missing end date. A dated row is revisited **only** by `Start` and `End` following SIMKL; for
  every other cell it is closed for good, which is the fact almost every conservative rule
  downstream traces back to.

**What may be written** is the guard's checklist (`5-guard.ts`): five whitelisted cells, one
inserted row per run, nothing but the tracked dates on a closed row, never a formula. The bounds it checks are the same
constants the planner writes with (`values.ts`), so a value one emits and the other refuses is
unrepresentable; the alignment checks — is this address the row the plan thinks it is — stay
independently derived, because a one-row misalignment is the only catastrophic failure the feature
has.

**The write protocol** is `io/apply.ts`, top to bottom: the snapshot tab rides the head of the one
atomic batch, the re-read is the only authority on what happened, verify's diff is on
`userEnteredValue` with the formula-rewrite exemption (`7-verify.ts` — read it before touching the
comparison; tightening it to text equality is the one change here that can corrupt the sheet
outright), and rollback is a wholesale paste from the snapshot, never a per-cell repair. A rollback
that cannot complete freezes the process and renames the snapshot tab out of the swept namespace
(`io/backups.ts`).

**What is retained across polls** is the catalogue store (`3-catalogue.ts`): reductions of both
upstreams' payloads, per-title stamps gated on watch activity with a daily ceiling, and season
runtimes with **no ceiling at all** — a finished season's lengths are terminal. Its map-presence
semantics (absent = unanswered, null = settled with nothing usable) are the store's own doc comment,
and the same distinction governs the TVDB id a detail lookup carries; getting either backwards
dates a row on a 503 and forfeits its cell permanently.

Upstream API references, and what they do not offer, are at the end of [AGENTS.md](AGENTS.md).
