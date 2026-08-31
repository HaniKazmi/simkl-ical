# simkl-ical

[![CI](https://github.com/HaniKazmi/simkl-ical/actions/workflows/ci.yml/badge.svg)](https://github.com/HaniKazmi/simkl-ical/actions/workflows/ci.yml)

Turn your [SIMKL](https://simkl.com) watchlist into a calendar feed you can subscribe to.

Self-hosted, no database, two dependencies. Point Apple Calendar, Google Calendar, Outlook
or anything else that speaks iCal at one URL and your upcoming episodes and film releases
show up alongside the rest of your week.

```
The Bear – S04E03                    Wed 12 Aug
Silo – S03E07                        Fri 14 Aug
Dune: Part Three                     Fri 18 Dec
```

## Why it exists

SIMKL has no per-user calendar endpoint. Airdates live in public CDN files covering the
entire database, and your library lives behind OAuth with no dates attached — neither is
useful alone. This service fetches both, joins them on `simkl_id`, and renders the
intersection as ICS.

SIMKL sells an official iCal feed as part of VIP. This is the self-hosted alternative, and
it gives you control over the filtering rules that the hosted one doesn't.

## Quick start

```sh
docker run --rm -it -v simkl-ical-data:/data \
  -e SIMKL_CLIENT_ID=your-client-id \
  ghcr.io/hanikazmi/simkl-ical npm run login
```

Enter the code it prints at <https://simkl.com/pin>. Then:

```sh
docker run -d --name simkl-ical -p 3000:3000 -v simkl-ical-data:/data \
  -e SIMKL_CLIENT_ID=your-client-id \
  -e FEED_TOKEN=$(openssl rand -hex 24) \
  -e TZ=Europe/London \
  ghcr.io/hanikazmi/simkl-ical
```

Your feed is at `http://localhost:3000/<FEED_TOKEN>/feed.ics`.

Get a client id by registering an app at <https://simkl.com/settings/developer/>.
**No client secret is needed** — the PIN flow authenticates with the client id alone.

### With Compose

```sh
cp simkl.secrets.env.example simkl.secrets.env     # fill in the two secrets
docker compose run --rm simkl-ical npm run login   # once, to authorise
docker compose up -d
```

Secrets live in `simkl.secrets.env` (gitignored). Everything else — timezone, release
country, grace window, published port, and the optional [sheet
sync](#google-sheet-sync-optional) — is set directly in `docker-compose.yml`, so the
deployment is self-describing and safe to commit. Edit it there.

Run the login **first**. `/healthz` answers `503` until a token exists, so a container
started beforehand sits marked `unhealthy` until the next poll picks the token up — it
looks broken and isn't. `docker compose run` pulls the image and creates the volume by
itself, so it works as the very first command.

Update with `docker compose pull && docker compose up -d`.

## Configuration

Under Compose, the first two go in `simkl.secrets.env` and the rest are set directly in
`docker-compose.yml`.

| Variable              | Default         | Notes                                                        |
| --------------------- | --------------- | ------------------------------------------------------------ |
| `SIMKL_CLIENT_ID`     | —               | **Required, secret.** From simkl.com/settings/developer       |
| `FEED_TOKEN`          | —               | **Required, secret.** Path segment of the feed URL. `openssl rand -hex 24` |
| `TZ`                  | `Europe/London` | **Set this.** Airdates are converted to local dates; a wrong zone shifts events by a day |
| `RELEASE_COUNTRY`     | `GB`            | ISO 3166-1 alpha-2, case-insensitive. Which country's cinema dates to use for films |
| `GRACE_DAYS`          | `14`            | How long an aired episode stays in the feed. Capped at 90     |
| `PORT`                | `3000`          | Port inside the container                                     |
| `DATA_DIR`            | `/data`         | Holds `token.json`, the last rendered `feed.ics`, and the sheet run log. `./data` outside Docker |
| `CALENDAR_REFRESH_MS` | `21600000` (6h) | How often to re-read the airdate calendars. Matches how often the CDN regenerates them |
| `ACTIVITIES_POLL_MS`  | `1800000` (30m) | How often to check your library for changes                   |
| `MOVIE_REFRESH_MS`    | `86400000` (24h)| How often to re-read film release dates, which move without any library change |

The three interval settings are floored at 60 seconds and `GRACE_DAYS` is clamped
to 0–90, so a mistyped value degrades to something sane rather than hammering
SIMKL or emptying the feed.

## What lands in the feed

| Your SIMKL list      | What's included             |
| -------------------- | --------------------------- |
| `shows/watching`     | every upcoming airing       |
| `shows/completed`    | every upcoming airing       |
| `shows/plantowatch`  | **S01E01 only**             |
| `anime/watching`     | every upcoming airing       |
| `anime/completed`    | every upcoming airing       |
| `anime/plantowatch`  | S01E01 only                 |
| `movies/plantowatch` | cinema date in your country |

Three rules worth knowing:

- **`completed` counts as watching.** SIMKL marks an ongoing show completed once you've seen
  everything aired so far, so a between-seasons show sits there. Excluding it would silently
  drop the next season.
- **Plan-to-watch contributes premieres only.** Including every episode of a show you haven't
  started would bury the calendar.
- **Recently aired episodes linger** for `GRACE_DAYS` so nothing vanishes the moment it airs.
  This is *not* filtered by watch state — the feed is a record of what aired, not a to-do
  list. A deep backlog stays in SIMKL where it belongs.

Events are all-day and marked transparent, so they never make you look busy. Episode titles
go in `DESCRIPTION` rather than `SUMMARY`, so the calendar doesn't surface a spoiler you
didn't choose to read.

Your `hold` and `dropped` lists are fetched but contribute nothing to the feed. They exist
for the sheet sync below, which needs to tell "you dropped this" from "SIMKL has never
heard of it".

Putting a show on hold or dropping it stops its episodes appearing, from the next poll.
Un-holding brings it back with no further action.

## Status page

`https://…/<FEED_TOKEN>/status` is a plain HTML page showing what the service is actually
doing: how many titles you hold at each status, what the last check found, the feed's
fetch→join→render steps with when each last ran, every upstream request it has made recently,
and a history of every edit the sheet sync has made — cell by cell, with what changed.

It is **as sensitive as the feed URL**, and behind the same token: it names your shows.
Treat it the same way, and note that a URL carrying a credential is kept by browser history
and bookmark sync. The page loads nothing from anywhere else, runs no JavaScript, and has no
button that starts work — requests never trigger a fetch. It never displays your `SHEET_ID`.

If a sheet sync ever freezes, this is where the repair instructions are: which backup tab to
copy back and which rows to delete. `/healthz` only reports *that* it froze.

## Subscribing

Use the full `https://…/<FEED_TOKEN>/feed.ics` URL as a *subscribed calendar*, not an import.

**Apple Calendar** lets you choose the refresh interval, so it reflects changes promptly.
**Google Calendar** polls on its own schedule — commonly 8–24 hours — and ignores every
refresh hint a feed can send. That's a Google limitation, not something this service can
influence.

Anyone with the URL can read your watchlist, so treat it as a credential: use a long
`FEED_TOKEN`, and serve it over HTTPS.

## Google Sheet sync (optional)

If you keep a spreadsheet of what you've watched, the same poll can maintain it. Off unless
`SHEET_ID` **and** a credential are both set — a target with no credential stays inert rather
than failing once per poll, so half-configuring it is safe. It costs no extra SIMKL requests
for the library: the watch detail rides along on the fetch the feed already makes.

| Variable                         | Default    | Notes                                                          |
| -------------------------------- | ---------- | -------------------------------------------------------------- |
| `SHEET_ID`                       | —          | The spreadsheet id, from its URL. Unset ⇒ none of this runs     |
| `SHEET_NAME`                     | `Sheet1`   | Which tab                                                       |
| `GOOGLE_SA_KEY_B64`              | —          | **Secret.** Base64 of the service-account JSON: `base64 -w0 sa.json` |
| `GOOGLE_APPLICATION_CREDENTIALS` | —          | Path to that JSON instead, for local dev                        |
| `SHEET_SYNC_MODE`                | `report`   | `off` / `report` / `apply`. Anything unrecognised clamps to `report` |
| `SHEET_SINCE_DAYS`               | `90`       | Counts and statuses need watch activity this recent; dates do not |
| `SHEET_MAX_EDITS`                | `30`       | Over budget refuses the whole plan rather than trimming it      |
| `SHEET_MAX_ROWS`                 | `20`       | Distinct rows in one run                                        |
| `TVDB_API_KEY`                   | —          | **Secret.** Gets each season's *own* average runtime. Unset, the cell falls back to SIMKL's show-wide runtime |
| `TVDB_PIN`                       | —          | **Secret.** Only for a user-supported TVDB key; a licensed one logs in without it |

### Setting it up

1. Create a service account in the GCP console — it needs no project roles — and download its
   JSON key.
2. Share the spreadsheet with the key's `client_email`. **Viewer is enough to start.**
3. Set `SHEET_ID` and `GOOGLE_SA_KEY_B64`, leave the mode at `report`, and read a run in the
   log. It plans in full and writes nothing.
4. Once the report looks right, re-share the sheet as **Editor** and switch to `apply`.

`GET /healthz` carries the mode, the last run and its outcome; the [status page](#status-page)
shows what each run actually wrote, and survives a restart.

### What it does

It writes exactly five things — a season row's episode count, its start and end dates, its
average episode runtime *into a blank cell only*, and a show row's status — and inserts a season
row when you start a new season. It never adds a show, never moves a count backwards, and never
writes a formula.

The start and end dates are the two that **keep following SIMKL** after the row is finished: if a
date changes upstream — you correct a watch date, or rewatch the last episode — the cell is
updated to match, even on a season that already has an end date. Nothing else on a dated row is
ever touched again.

They also ignore `SHEET_SINCE_DAYS`. Correcting the date you started a season in 2018 is a change
made *today*, but it moves no watch timestamp, so a recency window would never see it. What keeps
this safe on a sheet nobody touches is the record described below, not the window: a value never
seen to move is never written. Everything else — counts, statuses, runtimes, new rows — still needs
recent watch activity.

This only ever acts on changes made *from the point you switch it on*. It records what SIMKL says
the first time it sees each season and writes nothing that run, so dates your sheet and SIMKL have
always disagreed about are left exactly as they are; only a genuine change upstream produces a
write. That record lives in `data/sheet-baseline.json` — keep it on the same volume as your token,
since losing it means one silent run that re-records everything and any change made in the meantime
goes unnoticed.

The runtime is the one part that uses `TVDB_API_KEY`, and it buys accuracy rather than the
feature: with a key the cell gets that season's own average episode length, and without one it
gets SIMKL's show-wide runtime for the series. Only a title SIMKL has no runtime for at all
leaves the cell blank. It is written in the same batch that dates the row, because the runtime
cell is never revisited once the row is closed — so a season still airing gets its row added with
the cell blank, waiting for the close to fill it.

`TVDB_PIN` is needed only for a user-supported TVDB key; a licensed key logs in with the key
alone, and the pin is irrelevant when no key is set.

Every write is preceded by a server-side snapshot of the tab and followed by a read-back
compared against what was planned; anything unexpected restores the snapshot wholesale. If even
that fails it stops writing for the life of the process and tells you which tab holds the
pre-write state.

A run that finishes cleanly leaves no trace of its snapshot — the tab is dropped, along with any
an interrupted earlier run left behind. The exception is the stop-writing case: that snapshot is
renamed to **`_sync-REPAIR-…`** and kept, because restarting the container clears the
stopped-writing state and a later clean run would otherwise sweep away the very tab you were told
to repair from. So a `_sync-REPAIR-…` tab in your spreadsheet means something went wrong and is
waiting for you; delete it once you have copied it back.

Exactly one row is added per run, so starting two seasons between polls adds them over two runs —
the report names the one it deferred, and the sync asks for the next poll rather than waiting.

The sheet has to hold up its end: each show row's derived cells are self-sizing formulas over the
season rows beneath it, and that is what makes the show row read-only to the sync. See
[ARCHITECTURE.md](ARCHITECTURE.md#the-sheets-sharp-edges).

## Behind a reverse proxy

The container serves plain HTTP and does no TLS. To put it behind a proxy, drop the
`ports:` block from `docker-compose.yml` and attach the container to the proxy's network
instead — that way nothing can reach it except through the proxy:

```yaml
services:
  simkl-ical:
    # ports:            <- remove
    networks: [proxy]

networks:
  proxy:
    external: true
```

Then point your proxy at `simkl-ical:3000`. Any reverse proxy works; there's nothing
special about the setup.

## Running from source

Requires Node 26.0.0+ — for native TypeScript support, and for the Temporal API, which this
codebase uses for every date and duration. CI runs the suite on 26.0.0 and 26, so the floor is
tested rather than merely claimed.

Temporal is enabled at *build* time, not by a runtime flag, and not every distribution enables it —
Homebrew's `node` does not. Check with `node -p "typeof Temporal"`, which must print `object`. The
builds from [nodejs.org](https://nodejs.org) and the official `node:26-alpine` image both have it.

```sh
npm install
cp .env.example .env
npm run login
npm start
npm test
npm run typecheck
```

**No build step.** The source is TypeScript, and Node strips the types itself — there is no
`dist/`, no bundler, and the code that runs is the code you read. `tsc` is a dev dependency
used only for `npm run typecheck`; the container never compiles anything.

That constrains the source to erasable syntax: no enums, namespaces, parameter properties
or decorators. `erasableSyntaxOnly` in `tsconfig.json` makes any of those a compile error
rather than a runtime failure. Import specifiers carry the real extension
(`import './config.ts'`), as Node requires.

Routes: `GET /:token/feed.ics`, `GET /:token/status` and `GET /healthz`. Health is
unauthenticated, and answers `503` rather than `200` whenever the feed has stopped moving —
a revoked token, a CDN that has stopped answering, or a render that keeps throwing — so "the
container is up" and "the feed is current" are not the same signal.

One block per subsystem, each with its own timestamps. State and shape only — no free text:
a healthcheck is a contract, and every field here answers something a machine can act on.
*Why* something is wrong is a question for a person, so the wording lives on the [status
page](#status-page) instead.

```json
{
  "ok": false,
  "timezone": "Europe/London",
  "library": { "polledAt": "…", "syncedAt": "…" },
  "feed": {
    "events": 48,
    "renderedAt": null,
    "servingCached": true,
    "calendars": { "attemptedAt": "…", "freshAt": "…" }
  },
  "sheet": {
    "configured": true, "mode": "apply", "status": "applied",
    "lastRunAt": "…", "frozen": false
  }
}
```

`attemptedAt` and `freshAt` differ on purpose: a CDN failure is served from cache, so refreshes
keep succeeding while nothing fresh arrives, and only `freshAt` catches that. `syncedAt` moves
only when a list actually changed, so it being days old is normal.

A sheet-sync failure moves `sheet.status` and `sheet.frozen` but never makes it `503`: it cannot
affect the feed, and restarting the container would not fix it. The failure itself is on the
status page.

If your token is ever revoked the last good feed keeps serving and the error is logged;
re-authorise with `npm run login -- --force`.

Contributing, test conventions and the rules worth knowing before changing anything are in
[AGENTS.md](AGENTS.md); the design and its reasoning are in [ARCHITECTURE.md](ARCHITECTURE.md).

<details>
<summary><b>How it works</b></summary>

```
data.simkl.in/calendar/v2/*.json  ─┐
                                   ├─ join on simkl_id ─→ ICS ─→ GET /:token/feed.ics
api.simkl.com/sync/all-items  ─────┘
```

A background loop renders the feed into memory; requests never trigger a fetch. A client
polling hard can't amplify into SIMKL traffic, and a SIMKL outage degrades to a stale feed
rather than an empty one.

Airdate calendars are re-read every 6 hours with a conditional `GET`, matching how often the
CDN regenerates them. Your library is gated behind `/sync/activities`, checked every 30
minutes: when a status timestamp moves, one request asks for just the items that changed
since the last check. The gate ignores `playback` and `rated_at`, neither of which can change
the feed — otherwise a scrobbler reporting progress would pull a delta that renders
byte-identical output.

One request covers everything — shows, anime and films, at every status. Watching,
plan-to-watch and completed reach the feed; hold and dropped are there for the sheet sync.

| Event                         | API calls                                            |
| ----------------------------- | ---------------------------------------------------- |
| Nothing changed               | 1                                                    |
| Marked an episode watched     | 2                                                    |
| Added a film                  | 2 + one lookup for it                                |
| Removed something from a list | 3 (removals are never in a delta, so ids are diffed) |
| Cold start                    | 2 + one lookup per film                              |

Film release dates are re-read when a film is new, has no announced date, or is dated within
the next 30 days — never more than once a day each. Nothing in your library moves when a
studio delays a release, so nothing else would catch it; a film dated a year out answers the
same thing every day, so it is left alone until the date comes into range.

Steady state is about 48 API calls a day, well inside SIMKL's 10 requests/second limit.

With the sheet sync configured, a cold start adds one per-title episode list and one detail
lookup for each show with recent watch activity — around 35 for a 300-row sheet. Afterwards
only titles whose watch time actually moved are re-read, so a warm run is nearer two.

</details>

<details>
<summary><b>Notes on the SIMKL API</b></summary>

Behaviour the published docs don't cover or contradict, recorded in case it's useful to
anyone else building against this API:

- **The library's id field is `ids.simkl`; the calendar's is `simkl_id`.** Bridging the two
  names is the entire join. Empty lists come back as `{}`, not `{shows: []}`.
- **`/oauth/pin` returns the literal string `"DEVICE_CODE"`** as `device_code`. It's a
  placeholder — polling is keyed on `user_code`.
- **A burst of uncached sync calls returns `401 user_token_failed`, not `429`.** It looks
  exactly like a dead token and isn't; the same token works again minutes later. Re-authorising
  fixes nothing that waiting would not.
- **A film's top-level `released` field is unreliable**, consistently two days earlier than
  its real theatrical date. The correct dates are in `release_dates`, per country and per
  release type, where `type: 3` is theatrical and `type: 1` is a premiere screening (which
  can be a week or more earlier).
- **Monthly calendar archives use an unpadded month.** `/calendar/v2/2026/8/tv.json` works;
  `/2026/08/tv.json` returns 404.
- **The CDN ignores query strings**, so cache-busting is impossible — conditional `GET`
  against `Last-Modified` is the only way to detect a regeneration.
- **`next_to_watch` is `null` when you're caught up**, so it can't be used as a progress
  signal. `last_watched` is always populated.
- **`extended=full` is the gatekeeper on `/sync/all-items`.** It alone turns on `seasons[]`;
  `episode_watched_at=yes` and `include_all_episodes=yes` return byte-identical responses
  without it. With `extended=full` alone, completed and dropped titles still come back with no
  `seasons` at all, so `include_all_episodes=yes` is genuinely required too. `ids.simkl` needs
  none of them.
- **`extended` is a no-op on the per-title endpoints.** `/movies/{id}`, `/tv/{id}`,
  `/anime/{id}` and `/tv/episodes/{id}` return byte-identical responses with and without it —
  they always send the whole record.
- **`date_from` is compared strictly greater, at one-second granularity.** Passing back the
  exact `activities.all` returns nothing; one second earlier returns the newest change. Delta
  responses are *complete* item records rather than partial patches, so merging is a plain
  upsert. Nothing changed comes back as `{}` — two bytes.
- **Removals never appear in a delta.** `removed_from_list` says one happened but not what
  went; the only way to learn is to pull `extended=simkl_ids_only` and diff. That's 47 KB for a
  741-item library.
- **`/sync/all-items/{type}/{status}` fails open on a bad status.** An unrecognised segment
  returns every item of that type rather than a 404 — `/sync/all-items/movies/removed_from_list`
  is a full-library download, not an error.
- **The activities payload names the show category `tv_shows`; the sync path says `shows`.**
  The `movies` block omits `watching` and `hold` entirely rather than sending them null.
- **Airdates are UTC instants**, and a US evening broadcast is stamped the next day in UTC.
  Roughly 19% of entries land on a different local date in `America/New_York` than naive
  date-slicing would give, and 3% in `Europe/London`.
- **Anime films are filed under the anime type, not movies**, so a list of "anime" contains
  entries with no seasons at all.

</details>
