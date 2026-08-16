/**
 * The one cold `StatusInput`, shared by the model and the render suites.
 *
 * Here rather than in each file for the reason `test/sheet/fixtures.ts` gives
 * one level up: two copies of a 30-field literal do not fail to typecheck when
 * they *drift*, only when one omits a field. The two suites are meant to be
 * describing the same cold page — the render suite proves it prints nothing
 * unhandled, the model suite proves the values behind it are sane — so a field
 * that is benign in one copy and null in the other lets the render assertion
 * pass over a state the model assertion never saw.
 *
 * The `test/**\/*.test.ts` glob never runs this as a suite.
 */

import type { SheetRunRecord } from '../../src/sheet/io/journal.ts';
import type { StatusInput } from '../../src/status/1-model.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Fixed, so every relative label in an assertion is exact rather than flaky. */
export const NOW = Date.parse('2026-08-16T14:16:00.000Z');

/**
 * `ms` before `NOW`. Deliberately not `helpers.ts`'s `ago`, which counts back
 * from the real clock — importing both into one file is how a test starts
 * measuring against a moving `now`.
 */
export const before = (ms: number): string => new Date(NOW - ms).toISOString();

/** Nothing has run, nothing is configured, nothing is on disk. */
export const COLD: StatusInput = {
  now: NOW,
  appName: 'simkl-ical',
  version: '0.2.0',
  timezone: 'Europe/London',
  startedAt: null,
  ok: false,
  problems: [],
  polledAt: null,
  libraryError: null,
  counts: {},
  gate: null,
  activitiesPollMs: 2 * HOUR,
  events: 0,
  renderedAt: null,
  servingCached: false,
  renderError: null,
  calendarsAt: null,
  calendarsChangedAt: null,
  calendarError: null,
  calendarRefreshMs: 6 * HOUR,
  films: 0,
  filmsResolvedAt: null,
  filmsDue: false,
  sheetConfigured: false,
  sheetMode: 'off',
  sheetTab: 'Sheet1',
  sheetStatus: 'idle',
  sheetLastRunAt: null,
  sheetFrozen: null,
  sheetError: null,
  runs: [],
};

export const input = (over: Partial<StatusInput> = {}): StatusInput => ({ ...COLD, ...over });

/** One applied run, an hour old, editing a single cell. */
export const runRecord = (over: Partial<SheetRunRecord> = {}): SheetRunRecord => ({
  at: before(HOUR),
  status: 'applied',
  mode: 'apply',
  edits: [{ address: 'D609', field: 'Episode', note: 'Fargo S2: 3 -> 4 episodes' }],
  inserts: [],
  error: null,
  repeats: 1,
  ...over,
});
