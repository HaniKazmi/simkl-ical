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
import type { RequestRecord } from '../../src/api/requests.ts';
import type { StatusInput } from '../../src/status/1-model.ts';
import { libraryCounts, type LibraryCounts } from '../../src/library-counts.ts';
import type { SyncType } from '../../src/api/simkl/types.ts';
import { isoOf } from '../../src/shared/dates.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Fixed, so every relative label in an assertion is exact rather than flaky. */
export const NOW = Temporal.Instant.from('2026-08-16T14:16:00.000Z');

/**
 * `ms` before `NOW`. Deliberately not `helpers.ts`'s `ago`, which counts back
 * from the real clock — importing both into one file is how a test starts
 * measuring against a moving `now`.
 */
export const before = (ms: number): string => isoOf(NOW.subtract({ milliseconds: ms }));

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
  counts: libraryCounts(null),
  gate: null,
  movement: null,
  requests: [],
  activitiesPoll: Temporal.Duration.from({ milliseconds: 2 * HOUR }),
  events: 0,
  renderedAt: null,
  servingCached: false,
  renderError: null,
  calendarsAt: null,
  calendarsChangedAt: null,
  calendarError: null,
  calendarRefresh: Temporal.Duration.from({ milliseconds: 6 * HOUR }),
  films: 0,
  filmsResolvedAt: null,
  filmsDue: false,
  sheetConfigured: false,
  runtimesConfigured: false,
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

/** A recorded request, for the suites that render or model one. */
export const request = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  at: before(2 * MINUTE),
  service: 'simkl',
  component: 'poll',
  method: 'GET',
  path: '/sync/activities',
  status: 200,
  ms: 120,
  bytes: 1100,
  attempts: 1,
  error: null,
  ...over,
});

/** How the library last moved. Empty deltas is the common poll, not an edge. */
export const moved = (over: Partial<NonNullable<StatusInput['movement']>> = {}): NonNullable<StatusInput['movement']> => ({
  at: before(2 * MINUTE),
  deltas: [],
  updated: 0,
  removed: 0,
  ...over,
});

/** The all-zero counts with the named buckets raised. `libraryCounts(null)` is fresh per call, so mutating it is safe. */
export const countsWith = (byType: Partial<Record<SyncType, Record<string, number>>> = {}, other = 0): LibraryCounts => {
  const counts = libraryCounts(null);
  for (const [type, statuses] of Object.entries(byType)) Object.assign(counts.byType[type as SyncType], statuses);
  counts.other = other;
  return counts;
};
