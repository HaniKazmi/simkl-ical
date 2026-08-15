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
- **Errors are per-subsystem** (`calendar`, `library`, `render`). The two timers must not clear each
  other's failures. Nothing in the refresh path is allowed to be fatal — the process stays up and
  `/healthz` reports why.
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
