# AGENTS.md

Authoritative guidance for coding agents working in this repository, and a fast orientation for
humans. Detail lives in [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md);
what's here is what you need before touching anything.

## What this is

A self-hosted service that joins SIMKL's public airdate CDN with your private OAuth library and
serves the intersection as a subscribable iCal feed. No database, no build step, two runtime
dependencies (`fastify`, `ical-generator`).

## Commands

```sh
npm start                                  # run the service (src/index.ts)
npm test                                   # whole suite (node --test)
npm run typecheck                          # tsc --noEmit; the only "build" that exists
node --test test/join.test.ts              # one file
node --test --test-name-pattern 'grace'    # one test by name
```

Run `npm run typecheck && npm test` before calling a change done. Full command list, CI behaviour
and test conventions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules that bite

Each of these is cheap to violate and expensive to notice. Reasoning for all of them is in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Erasable syntax only.** Node strips the types; there is no compiler. No enums, namespaces,
  parameter properties or decorators.
- **Import specifiers carry the real extension** — `import { config } from './config.ts'` — and
  type-only imports must say `import type`.
- **Never slice an ISO airdate.** Airdates are UTC instants; `iso.slice(0, 10)` is wrong for ~19%
  of entries in `America/New_York`. Use `localDate()`.
- **UIDs are derived, never random.** A fresh UID each render makes calendar clients duplicate
  events instead of updating them.
- **Nothing in the refresh path may be fatal.** Failures land in a per-subsystem error slot and are
  reported by `/healthz`; the process stays up and keeps serving the last good feed.
- **The feed is only replaced when both halves of the join are present**, so a partial refresh
  never overwrites a complete feed loaded from disk.
- **Never poll `/sync/all-items` directly.** Gate it on `/sync/activities` and refetch only the
  lists whose signature changed — that is what `staleLists()` is for. SIMKL answers a burst of
  uncached sync calls with `401 user_token_failed`, not a `429`, so the symptom looks like a dead
  token rather than a rate limit. It clears on its own — the same token works again minutes later,
  so wait it out rather than reaching for `npm run login`; re-authorising fixes nothing the wait
  would not. This applies to ad-hoc inspection scripts too, not just the refresh path.
- **Tests must not reach the network or the real `./data`.** Use `withFetch`, `withConfig` and
  `withTempDataDir` from `test/helpers.ts` — on a real checkout `./data` holds a live OAuth token.

## Where things live

| Path | Role |
| --- | --- |
| `src/refresh.ts` | `FeedState` — the whole orchestration; the only thing that mutates |
| `src/join.ts`, `src/ics.ts` | Pure: calendars + library + releases → events → ICS string |
| `src/sources/` | One module per upstream (CDN calendars, OAuth library, per-film releases) |
| `src/simkl/` | Transport: retry/backoff, error classification, device-flow auth, API types |
| `src/server.ts` | Fastify; two routes, no state of its own |

Layering runs downward only, and `join`/`ics` stay pure — they take options with config-backed
defaults rather than reading `config` mid-body.

## Upstream API reference

SIMKL documents its API in an agent-readable form at <https://api.simkl.org/llms.txt>. It covers
every upstream this project touches — PIN device flow, `/sync/activities`, `/sync/all-items`, the
calendar files, per-title film lookups — along with the rate limits. Read it before changing
anything in `src/simkl/` or `src/sources/`; `src/simkl/types.ts` still wins on payload *shape*,
because it is written from live responses and the docs disagree in places.
