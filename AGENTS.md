# AGENTS.md

Authoritative guidance for coding agents working in this repository, and a fast orientation for
humans. Why the code is shaped this way lives in [ARCHITECTURE.md](ARCHITECTURE.md); what the
service does for its user is in [README.md](README.md). What's here is what you need before
touching anything.

## What this is

A self-hosted service that joins SIMKL's public airdate CDN with your private OAuth library and
serves the intersection as a subscribable iCal feed. No database, no build step, two runtime
dependencies (`fastify`, `ical-generator`).

Off the same poll it also keeps a hand-maintained Google Sheet of watch progress current — a show
grid on one tab and a films tab on another. That half is inert unless `SHEET_ID` and a Google
credential are both set; the runtime a closing season carries additionally needs `TVDB_API_KEY`,
and the films tab additionally needs `TMDB_API_KEY`.

## Commands

```sh
npm start                                  # run the service (src/index.ts)
npm run login                              # SIMKL device/PIN flow; writes data/token.json
npm run login -- --force                   # re-authorise over an existing token (the `--` is required)
npm test                                   # whole suite (node --test)
npm run typecheck                          # tsc --noEmit; the only "build" that exists
node --test test/feed/2-join.test.ts       # one file
node --test --test-name-pattern 'grace'    # one test by name
```

Run `npm run typecheck && npm test` before calling a change done.

## Rules that bite

Each of these is cheap to violate and expensive to notice. Reasoning for all of them is in
[ARCHITECTURE.md](ARCHITECTURE.md) or the named module.

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
  in four places only: `Retry-After`, which may be an RFC 7231 HTTP-date Temporal cannot parse, and
  the Google and TVDB token caches and the SIMKL device-flow deadline, which are process-internal
  epoch-millisecond countdowns with no zone and no calendar in them.
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
  timestamp of a real event, which is why the activity cut-off cannot move: it compares against a
  SIMKL timestamp from another machine.
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
  granularity, so passing back `activities.all` verbatim returns nothing at all. `deltaFrom` backs
  the watermark off by a second; `mergeDelta` is an idempotent upsert so the overlap is free. A
  watermark also advances only *after* the call that consumed it returns.
- **`removed_from_list` is not a status, and removals are in no delta.** A removal moves that
  timestamp and nothing else, so the only way to learn what went is to pull the membership set
  (`extended=simkl_ids_only`) and intersect — but only within the categories whose stamp actually
  moved, since an empty category is *omitted* from the response. A response that would drop most of
  a category is refused and answered with a **full pull**, because only the whole library settles
  what a diff can only guess at. And `/sync/all-items/{type}/{status}` **fails open** — an
  unrecognised status segment returns every item of that type instead of a 404, so
  `/sync/all-items/movies/removed_from_list` is a full-library download, not an error.
- **`item.status` is the only membership there is.** The library is one record per SIMKL id, so a
  move is a replacement and no stale copy survives to disagree. The one thing a record cannot supply
  is its *type*: an anime record is a show record plus `anime_type`, and both nest their title under
  `show`, so `LibraryEntry.type` has to come from the top-level response key it arrived under.
  The feed's airing rule is negative — a record with no `status` is still a title we hold — and its
  film rule is positive, because the library retains every completed film and a negative rule there
  would sweep hundreds of them into the feed and into a per-title lookup each.
- **The feed reads membership, never progress.** `join` takes exactly two things off a library
  record: its id and its `status`. A title moving between `watching` and `completed` — which SIMKL
  does every time you catch up — must produce the identical feed, so the render is gated on
  `mergeDelta`'s `reshaped`, not its `updated`. `test/feed/2-join.test.ts` holds the invariance
  directly; `test/orchestrator.test.ts` holds the render gate.
- **`extended` does nothing on the per-title endpoints.** `/movies/{id}`, `/tv/{id}`, `/anime/{id}`
  and `/tv/episodes/{id}` return byte-identical responses with and without it. On `/sync/all-items`
  it is the gatekeeper: `extended=full` alone turns on `seasons[]`, and `episode_watched_at=yes` and
  `include_all_episodes=yes` are no-ops without it. `ids.simkl` needs none of them.
- **A dated season row is revisited only by the fields that follow SIMKL** — `Start` and `End`,
  named in `TRACKED_FIELDS`. Every other cell it will ever carry has to be right in the one batch
  that closes it, which is the fact behind most of the planner's conservatism: a season holds its
  `End` open rather than closing blank whenever its runtime question is still open (the date comes
  from the watch timestamp, so waiting a poll costs nothing), and an inserted row leaves its runtime
  cell blank while the season is still airing. The runtime follows *airing* and the `End` date
  follows *watching* — `seasonAired` versus `seasonComplete` in `3-catalogue.ts`. The two tracked
  fields are exempt because what they hold is not the row's decision but SIMKL's: freezing them
  would preserve no judgement, only a stale copy of an upstream fact.
- **The fields that follow SIMKL ignore the activity window; everything else obeys it.** The window
  asks "has this been watched lately", which is not the question a corrected date asks — fixing the
  day you started a season in 2018 is a change made today, moves no watch timestamp, and may belong
  to a season never watched again. What keeps a dormant sheet quiet is the baseline, not the window:
  a value never seen to move is never written, which is a strictly better gate. `recent` in
  `planSync` therefore gates the catalogue demands and every write that reads the cell, while
  `followUpstream` runs above it. Both fields are recorded library-wide and for free by
  `observeWatches`, off the library alone — every season's first and last watch, whether or not the
  season is finished. What needs a lookup is *writing* `End`: the row must be complete, and only the
  episode list settles that for a season resolved by number. Recording is a different question and
  asks nothing, which is the distinction that matters — recorded only where a lookup had already
  been made for some other reason, most seasons have nothing to disagree with and `End` can never be
  followed at all. Recorded wide, a disagreement is a real move by one season, so the lookup a
  dormant block earns is one season's worth for one season's worth of change. `endMoved` is that
  test, and it excludes a row carrying its **own** id: `resolveRow` branches per row, such a row
  takes `complete` from its entry's counters, and no episode list can settle it.
- **A row follows SIMKL's dates only where it holds the same episodes as the season it resolved
  to.** A row matched by season *number* is that season only if the counts agree, and the sheet
  numbers some shows its own way: a Netflix batch split into parts gives Disenchantment five
  ten-episode rows against SIMKL's 20/20/10, so its row 2 resolves to a season whose first and last
  watch belong to rows 1 and 4. `fragment` in `followUpstream` declines both fields there —
  `season-fragment`, recorded so the row settles — and only on a **closed** row, because an open
  one's count lags by design and that gap is what the count write settles. Measured against the live
  sheet, every row whose dates would land inside a *different* row's span is caught. The test is a
  proxy rather than a proof — counts can agree while the episodes differ — so it is the shape of the
  mismatch that is load-bearing, not the count itself. Two things that look like collisions and are
  not: a season whose end date meets the next season's start, which is one evening's viewing rolling
  from one into the other, and a season finished months after it was begun, which reads as a jump
  only because the date it replaces was fabricated.
- **A change is measured against what was last observed, never against the cell.** SIMKL has no
  per-field revision and a disagreeing cell may have disagreed since before the sync first ran, so
  the only thing "changed" can mean is *different from what this service recorded* —
  `data/sheet-baseline.json`, via `io/baseline.ts`. A key with no record is a first sighting:
  recorded, and nothing written. That is what keeps this to changes from here on rather than a
  reconciliation of every standing mismatch. When a move does happen the new value goes in over
  whatever the cell holds.
- **A value is recorded only once the write carrying it has landed.** `PlanResult` splits what a
  pass saw into `observed` — first sightings, unmoved values, declined moves — and `writing`, the
  values it planned an edit for; `sync.ts` persists the second only on `applied`. Recorded early,
  the next poll compares against a value the sheet never received, finds nothing moved, and the
  change is lost for good. Same discipline as the library watermark, which advances only after the
  call that consumed it returns. `observeWatches` seeds `observed` library-wide, so `followUpstream`
  has to *withdraw* a field from it when it moves that field to `writing`.
- **Compare the days, not the instants.** `recordedSerial` renders the stored instant in the
  viewer's zone exactly as the current one is rendered, because a scrobbler restamping an episode
  moves `lastWatchedAt` by seconds and moves nothing the sheet can show. Storing the rendered day
  instead would be worse than it looks: a `TZ` change would make every row whose watch crosses
  midnight there differ at once — the same ~19% — and there is no adopt-on-differ path to absorb
  them, so it would be one library-wide edit set refused whole on budget, every poll.
- **Absent is not null, for `tvdbId` and for a season runtime alike.** Absent means the lookup has
  not answered; null means it answered that nothing is obtainable. Only null may date a row.
  Reading absent as null closes rows on a transient 503 and forfeits their cells for good, so
  `runtimeAnswer` in `4-plan.ts` returns a `pending` state rather than a nullable target.
- **The runtime write's scope is `runtimeScopeOk`, and it is stricter than `usesCourModel`** — both
  in `2-grid.ts`, with the Attack on Titan measurement in the doc comment. A SIMKL anime record
  numbers every cour `season: 1` and all cours share one TVDB id, so an anime row's number
  addresses no TVDB season; live-action agrees 35 of 35 seasons measured, Doctor Who's 2024
  renumbering included, because SIMKL keeps that as a separate record.
- **The planner is one pass, run to a fixpoint.** `planSync` returns the plan *and* the lookups it
  still needs; the sync fetches, folds them into the catalogue store, and re-plans until nothing
  new is demanded. There are no separate what-to-fetch passes to keep in agreement — a row the
  planner waits on is by construction a row the same pass demanded. Do not reintroduce a second
  planning path.
- **A season's runtime is only ever written into a blank cell**, and the bounds the guard checks are
  the same constants the planner converts with (`values.ts`) — a bound that exists twice is a
  whole-plan refusal waiting to fire on good data. The films tab's `Runtime` is a different column
  under a different rule: it follows SIMKL for the life of the row, and checks against the same two
  constants.
- **Never write a formula cell, and never write a show row except `Status`** — and, from the
  artwork page only, `Banner`, under the conditions above. Every derived cell on a show row rolls
  up from the season rows beneath it. Writing one replaces a live roll-up with a frozen number, and
  nothing would ever notice.
- **`Status` means one thing on a show row and another on a season row** — the derived state above,
  the date the season was last watched below — so which row a write landed on picks the rule, in
  `4-plan.ts` and `5-guard.ts` both. The note is written and moved on while the row is open, and the
  batch that dates the row takes it away: `End` says the same thing, and a row nothing revisits must
  not keep a running one. **Only a cell `ownsNote` accepts may be written into or cleared** — blank,
  or holding a note of the sync's own shape. The column is otherwise free space and what a reader
  typed there is not reconstructible, so the row closes around a hand-typed note rather than through
  it; and a formula is declined by the same predicate, because `season.status` is the cell's *result*
  and one rendering a date would read as the sync's own note, against a formula refusal that is
  unconditional and whole-plan. One copy for planner and guard, in `values.ts` with the bounds.
- **The note dates the count beside it, so it moves only when that count does** — written when a
  season row's `Episode` advances and when a row is inserted open, and never on a row this run
  leaves alone. `lastWatchedAt` drifts for reasons the count cannot see (a scrobbler restamping an
  episode, a delta re-reporting the same watch), so a fresh date on an unmoved row claims something
  happened. It also keeps the note out of the budget's way: every note lands on a row the plan
  already edits, so it costs an edit and never a distinct row, and the rows it can appear on are the
  ones that moved rather than every row watched inside the window — `checkBudgets` refuses
  *everything* over budget, and a note set that did not drain would stop the counts being written
  until enough rows aged out. The **clear** is not conditioned on the count: a stale note on a
  closing row goes whether or not that batch advanced anything.
- **An absent `CellEdit.value` empties a cell, and only a season's `Status` is ever emptied.** It is
  the encoding `writeCell` already uses to undo an inserted value, and the only one that leaves a
  cell a later read calls blank. Writing an empty string instead makes VERIFY's recognition of its
  own edit depend on how Sheets echoes such a write. Two consequences: `7-verify.ts` asks its
  expected map `has`, never `get`, because a planned clear carries no value and truthiness would
  read the emptied cell as a concurrent hand and roll a correct write back; and `sameValue` reads an
  empty `ExtendedValue` and an absent one as the same nothing, the way `isBlank` already does, so a
  read that spells an emptied cell either way still recognises the write. Which fields may be
  emptied is a whitelist of its own in `5-guard.ts` — `EMPTIABLE_EDITS`, and nothing on an insert,
  which fills a row rather than clearing one.
- **Ask the plan, not the grid.** Whether a write landed and which rows a rollback may delete are
  both answered from the planned writes. Row growth answers neither: `batchUpdate` is atomic, and an
  insert whose batch failed leaves the count unchanged. Reading growth as "it landed" freezes the
  process over an untouched sheet.
- **`userEnteredValue` is only stable while the grid is.** Inserting a row makes Sheets rewrite the
  relative A1 references in every formula it shifts, so the verifier compares formulas for still
  *being* formulas across an insert rather than for their text. Tightening that back to text
  equality is the one change here that can corrupt the sheet outright — read
  `src/sheet/7-verify.ts` before going near it.
- **One inserted row per run is carried by the plan's type** — `SheetPlan.insert` is a single value,
  because plan indices are pre-write and `insertDimension` applies cumulatively, so a second insert
  would land a row high. Do not widen it back to an array.
- **Every value interpolated into either page goes through the `html` tag.** Show titles,
  spreadsheet contents and upstream error bodies all reach both, so `shared/html.ts` escapes by
  default and `raw()` is reserved for the stylesheets. The safe-HTML brand is a module-private
  `Symbol` because a `{ html: string }` duck type is forgeable by any object with that key —
  including one parsed out of `sheet-runs.json`, which the status page renders verbatim. That file
  is the only one to audit for the brand; `status/2-html.ts` and `artwork/4-html.ts` are the two to
  audit for interpolation.
- **The status page fetches nothing, and sends `Referrer-Policy: no-referrer`.** The feed token is
  in the page's own URL, so any subresource — script, font, image, stylesheet — would carry it to a
  third party in a `Referer` header. That is about who else sees the token, not about the page
  showing it: the logs, `/healthz` and this page are all trusted surfaces, and printing the token or
  the spreadsheet id in them is fine. The page does carry three links, which is a different thing: a
  navigation the reader clicks is not a subresource, and `no-referrer` covers it either way.
- **The artwork page is the one page that runs a script and loads images off-origin, and it does
  both under its own CSP.** `script-src 'self'` admits only `artwork/app.js`; `img-src` names the
  three image CDNs and the bucket host and nothing else; `connect-src 'self'` is what the
  script's fetches run under. Every `src` and `href` on it is relative or on those four hosts, so
  **no absolute URL on the page carries the feed token** — pinned by `4-html.test.ts` and
  `server-artwork.test.ts` — and the same `no-referrer` header keeps the page's URL out of the CDNs'
  logs. The script builds every node with `createElement` and `textContent`: no `innerHTML`, no
  inline handlers, and an `<img>` gets a `src` only after its host passes the allowlist the CSP
  enforces, so a bad URL fails with a message rather than silently.
- **A page write and a sync run never overlap — `withSheetLock`.** The films verifier inspects every
  column but `id`, `Banner` included, so a `Banner` cell written between the sync's read and its
  verify is one the sync did not plan: VERIFY rolls the whole tab back, taking the page's write with
  it and refusing the sync's own. The sync holds the lock per tab from its first read to its last
  verify (lookups included — the plan is against that snapshot); a page write holds it for
  read → decide → write → verify and gives up with `SheetBusyError` after `LINK_WAIT`, which the
  route answers as a 503 with `Retry-After`. The object is already uploaded by then, and a re-pick
  puts the same bytes under the same key, so nothing is lost.
- **A `Banner` cell is the one cell on a show row the page may write, and only ever through
  `decideLink`.** The show-row rule below protects roll-up formulas; `Banner` is hand-maintained,
  not derived. The checklist: a formula is never written, unconditionally — kept where its value
  already links the bucket, refused otherwise; blank takes the static link for the title; a link
  into this bucket is kept under the key **the cell** names, so the 18 hand-written show rows and the
  two typo'd object names keep serving; a URL on another host is replaced only on `adopt`; anything
  else is refused. The write additionally requires the live cell to still hold what the page
  showed, the row to be found again by SIMKL id under the lock, and that row to still carry the
  title acted on. Not through the sync's planner or guard: their whitelists are the poll's.
- **The static link is one convention for both tabs, in `sheet/values.ts`.** `artworkKeyFor` is
  identity — the show tab's 291 `=CONCAT($Z$2,A#)` rows and the objects behind them are named by
  the title verbatim, so any normalisation breaks the link between a key derived here and one the
  sheet already holds — and `artworkLink` escapes only `%`, `#` and `?`, so a link the sync writes
  is byte-identical to the formula's output for the same title. With a movie bucket configured the
  films insert writes that link rather than a TMDB URL; the suite pins both buckets undefined so
  the films golden is unchanged.
- **The subscribe link is `webcal:`, and it is the one click target built from a request header.**
  Following the `https:` address downloads a snapshot, which a client imports once and never
  refreshes; only `webcal:` asks it to subscribe. That scheme needs a full authority, so the href
  cannot be root-relative and comes from `Host` — and a subscription is durable, so a wrong address
  keeps re-fetching with the token for as long as that calendar lives. `originOf` in `server.ts` is
  therefore the one place to be careful, and a `PUBLIC_URL` setting is the fix if `Host` ever stops
  being trustworthy here. The invariant the tests hold is **every URL carrying the feed token
  addresses this service**, in `server.test.ts` and `2-html.test.ts` both, scheme-agnostic so
  `webcal:` cannot slip past a check written for `https:`.
- **The page's look is hani.fyi's**, the index that links to it. Palette, `system-ui` type, cards on
  a tinted ground and 8px radii all come from there; state colour, `--faint` and a monospace token
  for tabular data are what a status page needs and a link list does not. Monospace is for paths,
  cell addresses and counts — prose in it is what made the old page hard to read.
- **The films tab is flat, and none of the season machinery reaches it.** One row per film, no
  block, no season number, no roll-up formula. `parseGrid`, `SeasonRow`, `seasonKey`,
  `runtimeScopeOk`, `deriveStatus` and the whole close/note/insert apparatus are season-shaped;
  `src/sheet/movies/` is a sibling numbered core, not a mode of the show one. What the two share is
  everything that holds no rule about what may be written: the transport, the driver loop
  (`runTab` in `sync.ts`, over a `TabSpec` each half supplies), the write-and-recover protocol
  (`applyPlan`, over an `ApplySpec`), the guard's alignment, shape and budget checks
  (`guard-core.ts`), `verifyAgainst`, the journal, the freeze latch and the baseline file.
  `6-requests.ts` is structural over `{row, column, value}` so it names no field. What they share
  no copy of is a single rule about what may be written — those live in each tab's own numbered
  modules, and the parent core imports nothing from `movies/`.
- **Three film columns follow SIMKL; eleven are written once and never revisited.** `Watch Date`,
  `Score` and `Runtime` qualify on `TRACKED_FIELDS`' own test — what they hold is not the row's
  judgement but SIMKL's — and all three come off the library delta with no lookup at all
  (`movie.runtime` agrees with the tab on 346 of 346 rows, `user_rating` on 245 of 245). Everything
  else is a judgement: which backdrop, which genre is primary, whether a franchise is "Pixar".
  `Name` is deliberately *not* followed though it is 95% derivable, because the 18 rows that
  disagree carry hand titles. `EDIT_FIELDS` in `movies/5-guard.ts` is the independent statement of
  that split — not `FOLLOWED_FIELDS`, because a whitelist derived from the planner would widen with
  it; the suite pins the two sets equal instead.
- **A recorded absence is not an absent record.** SIMKL holds no score for 102 of the films already
  on the tab, so leaving those unrecorded would make rating one later a *first sighting* — recorded,
  written nothing, silent from then on. `NOT_HELD` records the absence, which makes none → 8 a move.
  `recordedSerial` cannot make that distinction on a date, since it answers null for both, which is
  what `recordedDate` exists for. The reverse, 8 → none, is declined and recorded: `EMPTIABLE` is
  empty and nothing on this tab is ever cleared.
- **A film waits a poll rather than landing with eight blank cells.** Absent facts mean the lookup
  has not answered; null means it answered that nothing is obtainable — no TMDB id, or a 404 — and
  only null settles the film. Same discipline as `runtimeAnswer`, and the reason `TMDB_API_KEY` gates
  the whole half rather than degrading it. A *retryable* failure is never recorded, so the next poll
  asks again.
- **A film row is added below the last one, through `insertDimension`.** The blank rows past the
  data carry a different number format on `Watch Date` and none at all on `Release Date`, so a
  serial written straight into one renders as `28486`. `inheritFromBefore: true` is what carries the
  formats down — and the insert inherits the show grid's one-per-run limit for the same reason, that
  plan indices are pre-write.
- **A film write names the film, not just the row.** `FilmCellEdit` carries the SIMKL id the
  write is *for*, and the guard looks up what the grid says that row holds. A row index cannot be
  checked on its own: every blank cell compares equal to every other, so an edit aimed one row off
  finds a `previous` that matches and puts one film's value on another's row. The same map refuses a
  row carrying no id and a row whose id the tab repeats — the planner declines both, and a guard
  that only repeated the planner's reasoning would not be a second opinion.
- **A film row goes where `nextFilmRow` says, and both halves ask it.** Under the last film row, or
  under the **header** when the tab holds none. Anchored separately, the planner and the guard
  disagree by one exactly when the tab is empty, so a fresh tab never gains a row — and -1's own
  answer is the header row. `MovieGrid` carries `headerRow` for this; `rowCount` is a
  count, so the last usable index is one below it, and that check runs *before* the placement rule
  or it could only fire on a row placement had already accepted.
- **The budget is the poll's, not the tab's.** `SHEET_MAX_EDITS` and `SHEET_MAX_ROWS` are a blast
  radius for what one poll may change; counted per tab, one poll writes twice them while each half
  reports itself inside budget. What one half *sent* is carried into the next half's guard as
  `spent` — sent, not verified, because a batch that errored or could not be read back may well have
  landed; and sent, not planned, because a plan report mode never wrote or the freshness loop
  discarded changed nothing.
- **A run's tab is part of its identity.** Two halves failing the same way — an unshared
  spreadsheet, a 500 on the read — produce byte-identical records, so `sameAs` compares `tab` first;
  without it the second collapses into the first, takes its label, and the first tab's run is gone.
  And a repeat is collapsed against the last record *of its tab*: the record before a show run is
  nearly always a films run, and compared against that a state repeating on both tabs never
  collapses and two records a poll evict the real history in 25 polls.
- **A snapshot tab is named after the tab it copies, and a sweep takes only its own.** The name is
  the only state a snapshot has, and which tab it copies decides who may remove it: a films write
  verifying clean says nothing about `Sheet1`, and a failed show write kept its copy for the
  operator. A latch in the process cannot hold that rule — a restart resets it and the snapshot is
  not, and it protects in one direction only — so `backupName` carries the `sheetId` and
  `sweepBackups` filters on it, with no state at all.
- **A rejected TMDB credential is a fact about the token, not about any film.** A 401 sets
  `FilmStore.rejected`; no film is settled, the planner names the films waiting once in a note that
  says what to fix, and no further lookup — or poll — is asked for this process, since the token is
  read at start-up. Settling the pending films would file them as ones TMDB has nothing for, eight
  more every poll, and tell the operator to add by hand rows TMDB could build once the token is
  fixed.
- **The films fixpoint stops at the pass that plans the insert.** One row lands per run, so the
  lookups the films behind it need are the next poll's to make; fetched now, every pass to the
  ceiling spends another `MAX_LOOKUPS_PER_PASS`. The lookups a run chose not to make count as work
  and arm `retry` the way deferred inserts do — without that, the poll that inserts the last film
  the store knows has nothing deferred, and the rest of the backlog waits on unrelated activity.
- **`Cinema` is only ever written `TRUE`, and `id` only ever as text.** The tab spells "no" as an
  **absent** cell, never `FALSE`; and all 348 id cells hold `{ stringValue }`, so a number there
  compares unequal to every other row and the sync would not recognise its own insert. Both are
  guard rules, not conventions.
- **A film is SIMKL's `movies` category plus `anime` with an `anime_type` of `movie`** — a
  top-level key beside `show`, and the one fact `LibraryEntry.type` cannot supply, since `type` says
  only which response key the record arrived under. `ova`, `special` and `ona` stay with the show
  half: they hang off a series rather than standing alone, and the sheet files them that way. Every
  film status is *indexed* — a `plantowatch` row someone added by hand must be recognised rather
  than duplicated — but only `completed` earns a row.
- **Where an anime film goes is the sheet's answer, not the record's.** It may belong on the films
  tab or embedded in a show block, and nothing upstream says which, so an id already on the show
  grid is left there — `onShowGrid` in `movies/4-plan.ts`, read off a per-poll field `sync.ts`
  assigns the moment a grid parses. No grid parsed means no anime film is inserted, which costs one
  poll against a duplicate row that stands; and since an anime film's own presence stops the show
  half early-outing, a failed `Sheet1` read is the only way it meets that branch. The gate sits
  **inside `planInsert`'s `missing` filter**, because everything past that filter reports: below it,
  the show half's "add it by hand" note is moved rather than removed. Both halves therefore index
  anime films, and dropping them from `indexLibrary` is the tidy-up not to make — 20 sit on show-grid
  rows, which become `unknown-id` skips every poll.
- **The genre map drops rather than approximates.** TMDB's list in TMDB's own order, which is
  significance order and the reason this reads TMDB rather than SIMKL, whose genres arrive sorted
  alphabetically with that signal gone. First survivor is `Genre`, the rest are `Genres`, capped at
  three. `Documentary` → `True Story` is the one rename that is not a spelling, and it is unanimous
  on all three documentaries. `History` is dropped: 8 of the 10 films carrying it are filed
  `True Story`, but 1917 and The Other Boleyn Girl are fiction, and TMDB never lists it first so it
  could not pick a primary anyway. `Abstract` is in the vocabulary and nothing maps to it. An empty
  `Genres` is a state 27 rows hold, so the guard accepts one — `''.split(',')` is `['']`, and
  refusing that would make the planner's decision to omit the cell load-bearing for the guard.
- **Pick a TMDB value by what it is, never by where it sits in the array.** 166 of the 347 films on
  the tab carry more than one GB certificate and 8 disagree, usually a re-rating attached to a later
  digital or physical release; TMDB contracts no ordering, so `certificateOf` prefers the theatrical
  entry the way `releaseDateOf` prefers a theatrical date. Every one of these cells is written once,
  so an order-dependent answer is wrong for as long as the row exists.
- **`Release Date` borrows neither of a watch date's bounds.** Its floor is 1900, not `MIN_SERIAL`'s
  2000 — The Wizard of Oz is on the tab at 1939 and Star Wars at 1977. Its ceiling is a decade out,
  not tomorrow: a watch cannot be in the future and a release can, for a film seen at a preview
  before it opens here. Both bounds are the same kind of question — "is this a date at all" — set
  wide enough that only a payload error crosses them.
- **TMDB's 403 is transient.** TVDB counts one as `account` too, but there the cost is a runtime
  cell left blank for a poll; here `account` settles every pending film as permanently unbuildable
  for the life of the process, and TMDB answers a throttled or blocked request with 403 as readily
  as a rejected token. A wrong token still fails closed one poll later, through the 401 its next
  request gets.
- **One poll, two runs, one status.** `/healthz` reports the worse of the two, ordered
  `frozen > rolled-back > failed > refused > applied > reported > idle`, because a frozen films tab
  beside an applied show grid is a frozen sync. The freeze latch is process-wide and a show half that
  froze stops the films half in the same poll. `sheet-runs.json` records one line per tab, labelled
  by `tab`, and a record carrying none is a show run.
- **`sheet-runs.json` is observational, never control.** Nothing may read it to decide behaviour, so
  a corrupt or deleted history cannot change what the sync does.
- **Tests must not reach the network, the real `./data`, or the real spreadsheet.** Use `withFetch`,
  `withConfig` and `withTempDataDir` from `test/helpers.ts` — on a real checkout `./data` holds a
  live OAuth token, and `.env` holds a live `SHEET_ID`. The helpers module forces `sheetId` to
  undefined, `sheetSyncMode` to `off`, and `dataDir` to a throwaway path on import for exactly that
  reason. `clearSheetRuns()` from `sheet/io/journal.ts` belongs in any test that touches the
  history, the same way `clearCache()` does for the CDN. The baseline is the same hazard with worse
  consequences — it decides whether cells get written, so a run inheriting the last test's
  observations plans edits against values that test never set up — and `withConfig` therefore calls
  `clearBaseline()` itself rather than leaving it to be remembered. A test wanting a baseline seeds
  it inside the block.

## Where things live

Five buckets, and the folder a file sits in answers two questions: **which half of the project
needs it**, and **is it transport or business logic**.

| Path | Role |
| --- | --- |
| `src/orchestrator.ts` | `Orchestrator` — the poll, the timers, and `snapshot()`, the one export of state; owns the library and drives both halves. The poll's consequences are named predicates (`feedChanged`, `filmsNeedResolving`, `libraryMoved`) over one `PollOutcome` |
| `src/server.ts`, `src/index.ts`, `src/login.ts` | Fastify (seven routes, no state of its own beyond the artwork shell it builds), boot, and the device-flow CLI |
| `src/shared/` | Used by both halves, and with no feature knowledge at all: config, dates, errors, logger, signals, atomic-write |
| `src/health.ts` | What the state *means*: `assess` (restart-worthiness, the `/healthz` status code) and `pageHealthy` (the page's stricter question), plus the `/healthz` body |
| `src/library.ts` | How the library is gated, merged and read: the signatures, the delta merge, the removal diff |
| `src/library-counts.ts` | The library, counted — the status page's totals and movement deltas |
| `src/api/` | Every HTTP client, and no domain rules. `http.ts` is the one retrying transport, for JSON and for bytes (`requestBytes`, bounded); `simkl/`, `google/` (`client.ts` for Sheets, `storage.ts` for Cloud Storage, one `auth.ts` minting a token per scope), `tvdb/`, `tmdb/` are specs over it; `images.ts` the bounded, host-allowlisted download; `token-cache.ts` the one bearer cache; `pool.ts`, `requests.ts`, `cdn.ts` shared. `requests.ts` is the one exception to "no domain rules": `RequestComponent` names the callers, because which part of the service asked is not a fact any transport holds |
| `src/feed/` | iCal only |
| `src/sheet/` | Google Sheet sync only |
| `src/status/` | The HTML status page. Reads the snapshot and the request log; `server.ts` is its only reader |
| `src/artwork/` | The artwork page: both tabs and both buckets indexed, candidates from TMDB and TVDB, a pick that uploads and links. `server.ts` is its only reader |

`src/status/` and `src/artwork/` are **layers**, not peers of the halves: each sits above both
halves and below `server.ts`, and names `Orchestrator` only where it must (`status/` as a type,
`artwork/artwork.ts` for the library and the logger). **Nothing in `feed/`, `sheet/`, `api/`,
`shared/` or `orchestrator.ts` may import from either, and neither imports the other** — the
status page's artwork line is handed in by `server.ts`. Layering still runs downward only.

Each half is an **impure shell around a numbered pure core**: `io/` holds whatever talks outside
the process, and the rest carries its pipeline position in the filename, so `ls` prints the order.

`src/feed/` — FILMS → JOIN → RENDER

| Step | Module |
| --- | --- |
| FILMS | `1-films.ts` — every rule about film release dates; the fetch is `io/movies.ts` |
| JOIN | `2-join.ts` — calendars × library × releases → events |
| RENDER | `3-ics.ts` — events → an ICS string |
| io | `io/calendar.ts` (CDN airdates), `io/movies.ts` (per-title film fetch), `io/store.ts` (the rendered feed on disk) |
| — | `feed.ts` — the cycle that runs them |

`src/sheet/` — INDEX → READ/PARSE → (PLAN ⇄ FETCH) → GUARD → BUILD → APPLY → VERIFY → ROLLBACK

| Step | Module |
| --- | --- |
| INDEX | `1-index.ts` — library → what was watched, and the early-out that decides whether to read the grid at all |
| PARSE | `2-grid.ts` — snapshot → blocks, plus the two block predicates (`usesCourModel`, `runtimeScopeOk`) |
| FOLD | `3-catalogue.ts` — what the upstreams said, reduced and retained across polls: the `CatalogueStore`, the stamping discipline, and the reductions of both payloads |
| PLAN | `4-plan.ts` — grid + library + catalogue + baseline → `{ plan, demands, observed, writing }`; the sync re-plans until nothing new is demanded, and records `writing` only once the write lands |
| GUARD | `5-guard.ts` — a checklist of named rules; refuses a plan that does not re-derive |
| BUILD | `6-requests.ts` — a plan → one ordered batch, plus the rollback request builders |
| — | `guard-core.ts` — the rules both guards re-derive the same way: budget, cell shape, alignment; each guard passes its own `refuse` |
| VERIFY | `7-verify.ts` — did the write do exactly what was planned, for either tab: `verifyAgainst` holds the rules and `VerifiedTab` what a tab answers for itself |
| — | `values.ts` — the sheet's value conventions (serials, runtime bounds, the watch note's shape), one copy for planner and guard |
| io | `io/spreadsheet.ts` (read/apply/list), `io/catalogue.ts` and `io/runtimes.ts` (fetch only), `io/apply.ts` (the write-and-recover protocol, over an `ApplySpec` either tab supplies), `io/backups.ts` (the snapshot tab's whole life), `io/journal.ts` (the run history), `io/baseline.ts` (what SIMKL last said — the one file here that *decides* something) |
| — | `sync.ts` — the driver for **both** tabs: one loop (`runTab`) over a per-tab `TabSpec`, the two plan-fetch fixpoints, per-poll state in a `Poll`, the journal choke point |

`src/sheet/movies/` — the films tab. INDEX → PARSE → (PLAN ⇄ FETCH) → GUARD → BUILD → VERIFY

| Step | Module |
| --- | --- |
| INDEX | `1-index.ts` — library (films, anime included) → `FilmProgress`, and the early-out |
| PARSE | `2-grid.ts` — snapshot → one `MovieRow` per film; header resolution by text |
| FOLD | `3-catalogue.ts` — a TMDB payload reduced to the cells a row needs, retained across polls |
| PLAN | `4-plan.ts` — grid + library + catalogue + baseline → `{ plan, demands, observed, writing }` |
| GUARD | `5-guard.ts` — the films checklist; its whitelists are its own spec |
| VERIFY | `7-verify.ts` — what the films tab answers differently; the rules are the parent's `verifyAgainst` |
| — | `values.ts` — the tab's conventions: the genre map, the cinema window, the banner URL |
| io | `io/tmdb.ts` (fetch only) |

`6-` is absent on purpose: BUILD is the parent's `6-requests.ts` unchanged, which reads no field
name and so needs no films copy.

`src/status/` — MODEL → RENDER

| Step | Module |
| --- | --- |
| MODEL | `1-model.ts` — `{ snapshot, assessment, … }` → a `StatusModel`. Pure |
| RENDER | `2-html.ts` — a `StatusModel` → one self-contained page. Pure; owns `html`/`raw`/`escapeHtml` |
| — | `status.ts` — the shell: the only file here that names `Orchestrator`, reads the clock, the request ring and the journal |

`src/artwork/` — INDEX → CANDIDATES → DECIDE → RENDER

| Step | Module |
| --- | --- |
| INDEX | `1-index.ts` — both grids, the library, the run history and both bucket listings → one `ArtworkTitle` per row with a state a pick can act on, plus `summarise` |
| CANDIDATES | `2-candidates.ts` — a TMDB images payload or a TVDB artworks payload → `Candidate[]`, at the site's shape, ranked as a starting point |
| DECIDE | `3-decide.ts` — a `Banner` cell → `keep` / `write` / `refuse`; the whole of the page's guard, as a checklist |
| RENDER | `4-html.ts` — the model and the page; every value through `html` |
| — | `client.ts` — the page's script, served as `artwork/app.js`; `page.ts` — the read shell, index → model → page |
| io | `io/tmdb-images.ts`, `io/tvdb-art.ts` (fetch only), `io/sheet-link.ts` (`ensureLink`: the authoritative pass under the lock, one `updateCells`, one verify read, one journal record) |
| — | `artwork.ts` — the shell: the index cache (60 s, `?fresh=1` bypasses), the candidate cache (15 min, 200 titles, what lets a pick name a URL), the pick flow in its fixed order, and `summary()` for the status page |

Everything numbered stays pure (the catalogue store is stateful but I/O-free) — numbered modules
take options with config-backed defaults rather than reading `config` mid-body. Renumbering on
insertion is the cost of the scheme, and the right move when it comes up: appending a step out of
order forfeits the only thing the numbers buy.

Where a sheet run stopped is `SheetSyncStatus`, which `/healthz` reports as `sheet.status`:

| Status | Reached after |
| --- | --- |
| `idle` | PLAN produced nothing to write (also: the sync is off, unconfigured, or has not run) |
| `reported` | GUARD passed, and `report` mode stops there |
| `refused` | GUARD threw — nothing was written |
| `failed` | the batch errored and VERIFY found none of it in the sheet; also a run-level failure |
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
- On import it sets `config.retryBase` to 1ms, so a retry path takes microseconds rather than 15
  seconds, and blanks the sheet, TVDB and TMDB credentials as described above — and both artwork
  buckets, which have a golden behind them: with a movie bucket set the films insert writes a
  bucket link, and a leaked `ARTWORK_MOVIE_BUCKET` would fail `film-plan.json` for the wrong reason.
- `sheetSnapshot(rows)`, `cellOf(spec)`, `showRow`/`seasonRow` and `libraryOf(...items)` build sheet
  and library fixtures. A cell spec of `{ formula }` is the one that matters: only
  `userEnteredValue.formulaValue` distinguishes a formula, and a formula target must be refused
  unconditionally. `seasonRow`'s `episodes` option is the other: `null` is a blank runtime cell,
  which is the only state the runtime write may touch.
- A fetch handler must be **host-qualified**. `url.includes('/tv/')` matches TVDB's season path as
  well as SIMKL's, and answering one upstream with the other's body makes a test assert nothing.

`test/goldens/` pins the refactor-stable outputs byte-for-byte: the reference library's rendered
ICS, the reference grid's planned write set, and the `/healthz` key set. `UPDATE_GOLDENS=1 npm
test` rewrites them — do that only when the change to the output is the point of the commit.

`test/sheet/fixture.ts` builds grids with **named rows** — `fx.cell('fargoS2', …)` rather than a
bare index that re-points silently when a row is added — and `test/sheet/fake-sheets.ts` is the one
in-memory Sheets server every whole-run suite drives. One fake, deliberately: it is coupled to the
Google client's URL shapes, and a second copy is a second place that coupling breaks silently.

`test/artwork/fake-bucket.ts` is the in-memory Cloud Storage plus the image CDNs, composed
**in front of** `fakeSheets` (`next: sheet.handler`) for the whole-run suites: it answers what it
knows and hands the rest on. One fake, for the reason the Sheets one is one.

`api/cdn.ts` keeps a module-level cache; call its `clearCache()` in tests that touch a calendar,
and `clearTokenCache()` from `api/google/auth.ts` in tests that reach Google — it clears every
scope's cache, Sheets and Storage both — and the one from `api/tvdb/auth.ts` in tests that reach
TVDB. `api/cdn.ts` has no test file of its own: every path
through it is exercised by `test/feed/io/calendar.test.ts`, its only caller.

The sheet sync's tests are weighted towards `5-guard.test.ts` and `sync.test.ts` on purpose: a
one-row misalignment is the only catastrophic failure the feature has, and the guard, the request
ordering and the verify/rollback protocol are what prevent it.

## CI

`npm ci && npm run typecheck && npm test` on Node 26.0.0 and 26, then build, smoke test and publish
the image. 26.0.0 is the real floor — it is the release Temporal shipped in, and Temporal is a
*build-time* option rather than a runtime flag, so code using it typechecks green against
`@types/node` and then throws `ReferenceError` on a build without it. Homebrew's `node` is such a
build; the nodejs.org binaries and `node:26-alpine` are not. That is why the matrix pins the floor
rather than testing only `lts`, and why `shared/config.ts` asserts the global at module scope,
before the first `Temporal` value it builds. It cannot sit in `index.ts`: imports are hoisted, so
config fully evaluates before any statement there runs.

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
`src/api/simkl/` or the `io/` modules; `src/api/simkl/types.ts` still wins on payload *shape*,
because it is written from live responses and the docs disagree in places.

TVDB v4 is at <https://thetvdb.github.io/v4-api/>, and supplies the one thing SIMKL holds but does
not serve: per-episode runtime. `/tv/episodes/{id}` returns the same nine fields under every
`extended` value, there is no episode-level endpoint, and simkl.com renders the number server-side
but answers a non-browser User-Agent with a Cloudflare 403. TVDB is also what simkl.com *shows*:
its numbers match episode for episode where TMDb's differ by up to five minutes, in both
directions, with no rule behind it.

**That rejection of TMDb is about per-episode runtimes only.** The films tab reads TMDB for a
film's genres, certificate, backdrop, collection and release dates, none of which has a TVDB
equivalent — so the two decisions are about different data and do not disagree. TMDB v4 is at
<https://developer.themoviedb.org/reference/intro/getting-started>. Three things checked rather
than assumed: `TMDB_API_KEY` here is the **v4 read access token**, sent as a bearer, because v3's
`?api_key=` would put the credential into the paths `describeUrl` prints on the status page;
`append_to_response=release_dates,credits,images` folds a whole row's worth of columns into one
request; and `include_image_language=en` is what keeps a null-language backdrop — usually a poster
crop — out of the `Banner` cell, since 346 of 347 films have a real English one.

`GET /series/{id}/episodes/official?season={n}` returns one season, and one call is one season —
`links.page_size` is 500 and `next` is null on every season measured, up to a 28-episode cour. Three
behaviours checked rather than assumed: a season the series does not have answers **200 with an
empty list**, not a 404, so it never reaches the failure split; `page` is documented as required and
is optional; and login accepts a *wrong* pin rather than rejecting it, so the pin proves nothing and
only an invalid key fails, with `401 InvalidAPIKey`.

Google's Sheets API is at <https://developers.google.com/workspace/sheets/api/reference/rest>.
Two things it does not offer, checked rather than assumed: there is no revision surface at all, and
Drive's revisions can be listed, fetched, deleted or pinned but never named, created or reverted to.
That is why the sync snapshots a tab before writing instead of using version history.

The artwork page's three upstreams. TMDB's `/movie/{id}/images?include_image_language=en,null`
lists backdrops with dimensions and vote counts — the appended `images` on a film's detail carries
neither — and `en` backdrops carry the title across the frame while `null` ones are textless. TVDB's
`/series/{id}/artworks?type=2` lists posters, 680×1000 with a `_t` thumbnail and a `score`, in every
language — an anime often has only a Japanese one, so the page ranks English first rather than filtering;
type numbers are 1 banner, 2 poster, 3 background, 5 icon, 22 clear art, 23 clear logo. Cloud
Storage's JSON API is at <https://cloud.google.com/storage/docs/json_api>: a listing is
`GET /storage/v1/b/{bucket}/o` and an upload `POST /upload/storage/v1/b/{bucket}/o?uploadType=multipart`
— multipart because it is the one form that carries `cacheControl`, and without it a public object
is cached for an hour by default. The service account needs `roles/storage.objectAdmin` on both
buckets: `objectCreator` lets the first upload through and refuses the overwrite a re-pick needs.
Whether an upload must also ask for `predefinedAcl=publicRead` depends on the bucket: needed under
legacy ACLs, a 400 under uniform bucket-level access; `ARTWORK_PUBLIC_ACL` says which.
`storage.googleapis.com` sends `Access-Control-Allow-Origin: *` on a `GET` and not on a `HEAD`, so
verify CORS with a `GET`.
