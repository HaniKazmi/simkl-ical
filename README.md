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

| Source         | Library list         | Included                  |
| -------------- | -------------------- | ------------------------- |
| `tv.json`      | `shows/watching`     | every upcoming airing     |
| `tv.json`      | `shows/plantowatch`  | **S01E01 only**           |
| `anime.json`   | `anime/watching`     | every upcoming airing     |
| `anime.json`   | `anime/plantowatch`  | S01E01 only               |
| `/movies/{id}` | `movies/plantowatch` | cinema date in your country |

Events are all-day and transparent, so they never mark you busy. Episode titles are kept
out of `SUMMARY` and put in `DESCRIPTION` — a calendar shouldn't surface a spoiler you
didn't choose to read.

Only upcoming entries appear; the backlog stays in SIMKL.

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

```sh
docker compose up -d --build
docker compose run --rm simkl-ical npm run login   # once, to authorise
```

The compose file deliberately has **no `ports:`** — the container is reachable only on
Caddy's Docker network, so nothing can bypass the proxy. It expects an external network
named `caddy`.

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
- **33-day horizon applies to episodes only.** The TV and anime calendars are a rolling
  33-day window; films are unbounded.
- **Refresh.** CDN calendars every 3h (conditional GET; the CDN ignores query strings, so
  there's no other way to detect a regeneration). `/sync/activities` every 15m, which gates
  the five library calls. Requests never trigger a fetch.
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
