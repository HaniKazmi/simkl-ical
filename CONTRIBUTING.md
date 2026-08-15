# Contributing

Working on the code. For how the service is put together see [ARCHITECTURE.md](ARCHITECTURE.md);
for the rules that bite most often, [AGENTS.md](AGENTS.md).

## Commands

```sh
npm start                                  # run the service (src/index.ts)
npm run login                              # SIMKL device/PIN flow; writes data/token.json
npm run login -- --force                   # re-authorise over an existing token (the `--` is required)
npm test                                   # whole suite (node --test)
npm run typecheck                          # tsc --noEmit; the only "build" that exists
node --test test/join.test.ts              # one file
node --test --test-name-pattern 'grace'    # one test by name
```

There is no build step and no bundler — Node strips the types itself, so the constraints on what
syntax you can use are real rather than stylistic. See
[No build step](ARCHITECTURE.md#no-build-step).

## CI

`npm ci && npm run typecheck && npm test` on Node 22.18 and 24, then build, smoke test and publish
the image. 22.18 is the real floor — code using a newer API typechecks green against `@types/node`
and then crashes on the documented minimum, which is why the matrix pins it rather than testing
only `lts`.

The smoke test runs the built image and asserts `/healthz` answers with parseable JSON, a wrong
feed token gets a 404, and the right one returns something starting `BEGIN:VCALENDAR`.

## Tests

`node:test` + `node:assert/strict`, one file per module, no framework and no mocking library.
`test/helpers.ts` is doing real safety work, not saving keystrokes:

- `withFetch(handler, fn)` — swaps `globalThis.fetch` and records every URL. Most assertions are on
  the call log: that a poll made one request rather than eight.
- `withConfig(overrides, fn)` — config is a singleton; a missed restore leaks into other files.
- `withTempDataDir(fn)` — `config.dataDir` defaults to `./data`, which on a real checkout holds a
  live OAuth token.
- The module sets `config.retryBaseMs = 1` on import, so a retry path takes microseconds rather
  than 15 seconds. It also forces `config.sheetId = undefined` and `config.sheetSyncMode = 'off'`:
  `SHEET_ID` lives in `.env` and `config.ts` loads it at import, so a test that forgot to override
  would write to the real spreadsheet.
- `sheetSnapshot(rows)`, `cellOf(spec)` and `libraryOf(...items)` build sheet and library fixtures.
  A cell spec of `{ formula }` is the one that matters: only `userEnteredValue.formulaValue`
  distinguishes a formula, and a formula target must be refused unconditionally.

`sources/calendar.ts` keeps a module-level cache; call `clearCache()` in tests that touch it, and
`clearTokenCache()` from `sheets/auth.ts` in tests that reach Google. `sources/shows.ts` has no
cache of its own — `SheetSync` retains catalogue results and decides when to re-read.

The sheet sync's tests are weighted towards `sheet-safety.test.ts` on purpose: a one-row
misalignment is the only catastrophic failure the feature has, and the guards and the request
ordering are what prevent it.
