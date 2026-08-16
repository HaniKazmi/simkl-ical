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
| `DATA_DIR`            | `/data`         | Holds only `token.json` and the last rendered `feed.ics`. `./data` outside Docker |
| `CALENDAR_REFRESH_MS` | `10800000` (3h) | How often to re-read the airdate calendars                    |
| `ACTIVITIES_POLL_MS`  | `7200000` (2h)  | How often to check your library for changes                   |
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
SIMKL reports a move only against the list it moved *to*, so the show stays listed under
`watching` as well — the feed goes by the status on the item rather than by which list it
turned up in. Un-holding brings it back with no further action.

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
| `SHEET_SINCE_DAYS`               | `90`       | Nothing is touched without watch activity this recent           |
| `SHEET_MAX_EDITS`                | `30`       | Over budget refuses the whole plan rather than trimming it      |
| `SHEET_MAX_ROWS`                 | `20`       | Distinct rows in one run                                        |

### Setting it up

1. Create a service account in the GCP console — it needs no project roles — and download its
   JSON key.
2. Share the spreadsheet with the key's `client_email`. **Viewer is enough to start.**
3. Set `SHEET_ID` and `GOOGLE_SA_KEY_B64`, leave the mode at `report`, and read a run in the
   log. It plans in full and writes nothing.
4. Once the report looks right, re-share the sheet as **Editor** and switch to `apply`.

`GET /healthz` carries the mode, the last run and its outcome.

### What it does

It writes exactly three things — a season row's episode count, a season row's end date, and a
show row's status — and inserts a season row when you start a new season. It never adds a show,
never touches a season that already has an end date, never moves a count backwards, and never
writes a formula.

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

Requires Node 22.18+ (for native TypeScript support). CI runs the suite on 22.18 and 24,
so the floor is tested rather than merely claimed.

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

Routes: `GET /:token/feed.ics` and `GET /healthz`. Health is unauthenticated, and answers
`503` rather than `200` whenever the feed has stopped moving — a revoked token, a CDN that
has stopped answering, or a render that keeps throwing — so "the container is up" and "the
feed is current" are not the same signal.

One block per subsystem, each with its own timestamps and its own error, plus `problems`:
everything wrong right now, worst first, and empty when there is nothing to say.

```json
{
  "ok": false,
  "timezone": "Europe/London",
  "problems": ["no token — run `npm run login`", "nothing has been rendered yet"],
  "library": { "polledAt": "…", "syncedAt": "…", "error": "no token — run `npm run login`" },
  "feed": {
    "events": 48,
    "renderedAt": null,
    "servingCached": true,
    "error": null,
    "calendars": { "attemptedAt": "…", "freshAt": "…", "error": null }
  },
  "sheet": {
    "configured": true, "mode": "apply", "status": "applied",
    "lastRunAt": "…", "frozen": false, "error": null
  }
}
```

`attemptedAt` and `freshAt` differ on purpose: a CDN failure is served from cache, so refreshes
keep succeeding while nothing fresh arrives, and only `freshAt` catches that. `syncedAt` moves
only when a list actually changed, so it being days old is normal.

A sheet-sync failure is reported in `sheet.error` but is deliberately absent from `problems` and
never makes it `503`: it cannot affect the feed, and restarting the container would not fix it.

If your token is ever revoked the last good feed keeps serving and the error is logged;
re-authorise with `npm run login -- --force`.

Contributing, test conventions and the rules worth knowing before changing anything are in
[AGENTS.md](AGENTS.md); the design and its reasoning are in [ARCHITECTURE.md](ARCHITECTURE.md).

<details>
<summary><b>How it works</b></summary>

```
data.simkl.in/calendar/v2/*.json  ─┐
                                   ├─ join on simkl_id ─→ ICS ─→ GET /:token/feed.ics
api.simkl.com/sync/all-items/…  ───┘
```

A background loop renders the feed into memory; requests never trigger a fetch. A client
polling hard can't amplify into SIMKL traffic, and a SIMKL outage degrades to a stale feed
rather than an empty one.

Airdate calendars are re-read every 3 hours with a conditional `GET`. Your library is
gated behind `/sync/activities`, checked every 2 hours: activities carries a timestamp per
list, so only the lists that actually changed are refetched. It ignores `playback` and
`rated_at`, neither of which can change the feed — otherwise a scrobbler reporting progress
would trigger a refetch that renders byte-identical output.

Eleven lists are covered — watching, plan-to-watch, completed, hold and dropped for both shows
and anime, plus plan-to-watch films. Only seven reach the feed; the rest are there for the
sheet sync.

| Event                         | API calls                                    |
| ----------------------------- | -------------------------------------------- |
| Nothing changed               | 1                                            |
| Marked an episode watched     | 2                                            |
| Added or removed a film       | 2 + one lookup per film                      |
| Removed something from a list | 6 (removals are only reported per category)  |
| Cold start                    | 12 + one lookup per film                     |
| Once a day                    | 1 + one lookup per film                      |

Film release dates get that daily re-read because nothing in your library moves when a
studio delays a release — gating them on list changes alone meant the feed kept the old
date until it aged out, at which point the film disappeared until the next restart.

Steady state is about 12 API calls a day, well inside SIMKL's 10 requests/second limit.

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
- **`include_all_episodes=yes` is required** for the completed and dropped lists, or the
  `seasons` key is absent entirely rather than empty.
- **Airdates are UTC instants**, and a US evening broadcast is stamped the next day in UTC.
  Roughly 19% of entries land on a different local date in `America/New_York` than naive
  date-slicing would give, and 3% in `Europe/London`.
- **Anime films are filed under the anime type, not movies**, so a list of "anime" contains
  entries with no seasons at all.

</details>
