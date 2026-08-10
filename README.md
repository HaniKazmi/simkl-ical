# simkl-ical

Serves your upcoming SIMKL episodes and film releases as a subscribable iCal feed.

SIMKL has no per-user calendar endpoint. Airdates live in public CDN JSON covering the
entire database; your library lives behind OAuth with no dates attached. This service
fetches both and joins them on `simkl_id`.

```
data.simkl.in/calendar/v2/*.json  ─┐
                                   ├─ join on simkl_id ─→ ICS ─→ GET /:token/feed.ics
api.simkl.com/sync/all-items/…  ───┘
```

## What lands in the feed

| Source         | Library list         | Included                    |
| -------------- | -------------------- | --------------------------- |
| `tv.json`      | `shows/watching`     | every upcoming airing       |
| `tv.json`      | `shows/completed`    | every upcoming airing       |
| `tv.json`      | `shows/plantowatch`  | **S01E01 only**             |
| `anime.json`   | `anime/watching`     | every upcoming airing       |
| `anime.json`   | `anime/completed`    | every upcoming airing       |
| `anime.json`   | `anime/plantowatch`  | S01E01 only                 |
| `/movies/{id}` | `movies/plantowatch` | cinema date in your country |

`completed` is treated exactly like `watching`, not excluded: SIMKL marks an ongoing show
completed once you have watched everything aired so far, so a between-seasons show sits
there. Dropping it would silently lose the next season.

Events are all-day and transparent, so they never mark you busy. Episode titles are kept
out of `SUMMARY` and put in `DESCRIPTION` — a calendar shouldn't surface a spoiler you
didn't choose to read.

Recently aired episodes linger for `GRACE_DAYS` (default 14) so nothing disappears the
moment it airs. This is deliberately **not** filtered by watch state — the feed is a record
of what aired, not a to-do list. Anything older than the window drops off; a deep backlog
stays in SIMKL where it belongs.

## Setup

```sh
cp .env.example .env      # fill in SIMKL_CLIENT_ID, generate FEED_TOKEN
npm install
npm run login             # device flow: enter the code at simkl.com/pin
npm start
```

Register an app at <https://simkl.com/settings/developer/> for a client id. **No client
secret is needed** — the PIN flow authenticates with the client id alone. A secret is only
required for the browser redirect flow, which this doesn't use.

`FEED_TOKEN` is the secret path segment of your feed URL: `openssl rand -hex 24`.

### Routes

- `GET /:token/feed.ics` — the feed
- `GET /healthz` — event count and last-refresh timestamps, unauthenticated

## Docker

The image is built and published by GitHub Actions to
`ghcr.io/hanikazmi/simkl-ical`, so the host never needs the source or a toolchain — only
`docker-compose.yml` and a `.env`.

```sh
docker compose run --rm simkl-ical npm run login   # first: pulls image, creates volume, writes token
docker compose up -d
```

**Run the login first.** `/healthz` answers `503` until a token exists, because nothing has
been rendered yet. Docker won't restart the container for that — `restart: unless-stopped`
only acts on exit — but a container started before login sits marked `unhealthy` until the
next activities poll picks the token up, which looks broken and isn't. Starting with
`docker compose run` avoids it: that command pulls the image and creates the volume on its
own.

To update:

```sh
docker compose pull && docker compose up -d
```

The compose file deliberately has **no `ports:`** — the container is reachable only on
Caddy's Docker network, so nothing can bypass the proxy. It expects an external network
named `caddy`. It also has no `build:` key on purpose: with both `image` and `build`
present, Compose tries to build when the image is missing locally, which fails on a host
with no checkout. To build by hand during development, use `docker build -t simkl-ical .`.

### CI

`.github/workflows/ci.yml` runs the test suite, builds the image for `linux/amd64`, smoke
tests that it boots and serves `/healthz`, then pushes to GHCR. Pull requests build and
smoke test but do not publish. Tags: `latest` on `main`, `sha-<short>` on every build, and
semver if you push a `v*` tag.

The GHCR package is public, so the host pulls with no credentials. Note that **GHCR
packages default to private** — after the first successful run, flip it to public once in
the package settings on GitHub.

### Caddy

Add one block to your existing Caddyfile:

```caddy
tv.example.com {
    reverse_proxy simkl-ical:3000
}
```

Then point a Cloudflare Tunnel hostname at Caddy the same way as your other services.

## Behaviour notes

- **Timezone.** Set `TZ` explicitly; never let it default. Airdates are UTC instants and
  are converted to local dates — 2.8% of entries land on a different day in `Europe/London`
  than naive date-slicing would give, and 19% in `America/New_York`.
- **Film releases** come from per-title `/movies/{id}` lookups, not the CDN movie calendar.
  Two reasons. The calendar is a rolling 33-day window, so a 2027 release would never show
  up in it; and the film's top-level `released` field is consistently *two days earlier*
  than its real theatrical date (Dune: Part Three reports `2026-12-16` against an actual
  `2026-12-18`). The correct dates live in `release_dates`, per country and per release
  type — set `RELEASE_COUNTRY` and the theatrical date for that territory is used, falling
  back to US. A `type: 1` premiere screening is only used if nothing else is listed.
- **Episode horizon is roughly −`GRACE_DAYS`/+34 days.** The rolling CDN file only spans
  about −2/+34, so any grace window longer than 2 days additionally pulls the monthly
  archives at `data.simkl.in/calendar/v2/{YEAR}/{MONTH}/{type}.json` and merges them, with
  the rolling file taking precedence on overlap. **The month in that path is not
  zero-padded** — `/2026/8/` works, `/2026/08/` returns 404. Films are unbounded.
- **Cache size.** Each monthly archive is 0.3–4 MB per type and is cached on disk under
  `DATA_DIR/cache`; a 14-day window keeps about 8 MB. Warm fetches are all `304`s.
- **Refresh.** CDN calendars every 3h (conditional GET; the CDN ignores query strings, so
  there's no other way to detect a regeneration). `/sync/activities` every 2h, which gates
  the five library calls and the film lookups. Requests never trigger a fetch.

  Activities carries a timestamp per status, so each list is gated individually and only
  the lists that actually moved are refetched. It ignores `playback`, `rated_at` and the
  `all` roll-up, none of which can change the feed — otherwise a scrobbler reporting
  progress would trigger a refetch that renders byte-identical output.

  | Event | API calls |
  | ----- | --------- |
  | Nothing changed | 1 |
  | Marked an episode watched | 2 |
  | Added or removed a film | 2 + one lookup per film |
  | Removed something from a list | 4 (a removal is only reported against `removed_from_list`, so it invalidates its whole category) |
  | Cold start | 8 + one lookup per film |

  In steady state that is **12 API calls/day** plus a couple per change, and 32–48 CDN
  requests/day (nearly all `304`). Override with `ACTIVITIES_POLL_MS` and
  `CALENDAR_REFRESH_MS`.
- **Google Calendar** polls subscribed URLs on its own schedule, commonly 8–24h, and ignores
  every refresh hint. Apple Calendar lets you set the interval.
- **Revoked token.** Logged loudly; the last good feed keeps serving. Re-run
  `npm run login -- --force`.

## Tests

```sh
npm test
```

Covers the things that fail silently: timezone conversion across zones, UID stability,
the plan-to-watch premiere rule, past-date dropping, line folding and escaping.
