/**
 * The one cold `StatusInput`, shared by the model and the render suites.
 *
 * Here rather than in each file for the reason `test/sheet/fixture.ts` gives
 * one level up: two copies of a nested literal do not fail to typecheck when
 * they *drift*, only when one omits a field. The two suites are meant to be
 * describing the same cold page — the render suite proves it prints nothing
 * unhandled, the model suite proves the values behind it are sane — so a field
 * that is benign in one copy and null in the other lets the render assertion
 * pass over a state the model assertion never saw.
 *
 * `input()` takes the page's knobs by flat name and places each on the nested
 * `Snapshot`, so a test says `input({ renderedAt })` rather than spreading four
 * levels by hand.
 *
 * The `test/**\/*.test.ts` glob never runs this as a suite.
 */

import type { SheetRunRecord } from '../../src/sheet/io/journal.ts';
import type { RequestRecord } from '../../src/api/requests.ts';
import type { SheetSyncStatus } from '../../src/sheet/sync.ts';
import type { SheetSyncMode } from '../../src/shared/config.ts';
import type { StatusInput } from '../../src/status/1-model.ts';
import type { LibraryMovement, PollOutcome, Snapshot } from '../../src/orchestrator.ts';
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

const coldSnapshot = (): Snapshot => ({
  startedAt: before(MINUTE),
  library: { polledAt: null, syncedAt: null, error: null, counts: libraryCounts(null), poll: null, movement: null },
  feed: {
    events: 0,
    renderedAt: null,
    servingCached: false,
    error: null,
    calendars: { attemptedAt: null, freshAt: null, changedAt: null, error: null },
    films: { resolved: 0, resolvedAt: null },
  },
  sheet: { configured: false, status: 'idle', lastRunAt: null, frozen: null, error: null },
});

/** Nothing has run, nothing is configured, nothing is on disk. */
export const COLD: StatusInput = {
  now: NOW,
  snapshot: coldSnapshot(),
  assessment: { ok: false, problems: [] },
  appName: 'simkl-ical',
  version: '0.2.0',
  timezone: 'Europe/London',
  activitiesPoll: Temporal.Duration.from({ milliseconds: 2 * HOUR }),
  calendarRefresh: Temporal.Duration.from({ milliseconds: 6 * HOUR }),
  filmsDue: false,
  runtimesConfigured: false,
  sheetMode: 'off',
  sheetTab: 'Sheet1',
  requests: [],
  runs: [],
};

/** The page's knobs, by flat name, placed onto the nested input by `input()`. */
export interface InputOver {
  now?: Temporal.Instant;
  ok?: boolean;
  problems?: string[];
  activitiesPoll?: Temporal.Duration;
  calendarRefresh?: Temporal.Duration;
  filmsDue?: boolean;
  runtimesConfigured?: boolean;
  sheetMode?: SheetSyncMode;
  sheetTab?: string;
  requests?: RequestRecord[];
  runs?: SheetRunRecord[];

  startedAt?: string;
  polledAt?: string | null;
  libraryError?: string | null;
  counts?: LibraryCounts;
  /** Expanded to a whole `PollOutcome` — these three are all the page reads. */
  gate?: { pull: PollOutcome['pull']; updated: number; removed: number } | null;
  movement?: LibraryMovement | null;

  events?: number;
  renderedAt?: string | null;
  servingCached?: boolean;
  renderError?: string | null;
  calendarsAt?: string | null;
  calendarsChangedAt?: string | null;
  calendarError?: string | null;
  films?: number;
  filmsResolvedAt?: string | null;

  sheetConfigured?: boolean;
  sheetStatus?: SheetSyncStatus;
  sheetLastRunAt?: string | null;
  sheetFrozen?: string | null;
  sheetError?: string | null;
}

const pollOf = (gate: NonNullable<InputOver['gate']>): PollOutcome => ({
  at: before(MINUTE),
  changed: gate.pull !== 'none',
  pull: gate.pull,
  removalsChecked: false,
  refusedRemovals: false,
  updated: gate.updated,
  reshaped: 0,
  removed: gate.removed,
});

export const input = (over: InputOver = {}): StatusInput => {
  const cold = coldSnapshot();
  return {
    ...COLD,
    now: over.now ?? NOW,
    assessment: { ok: over.ok ?? COLD.assessment.ok, problems: over.problems ?? COLD.assessment.problems },
    activitiesPoll: over.activitiesPoll ?? COLD.activitiesPoll,
    calendarRefresh: over.calendarRefresh ?? COLD.calendarRefresh,
    filmsDue: over.filmsDue ?? COLD.filmsDue,
    runtimesConfigured: over.runtimesConfigured ?? COLD.runtimesConfigured,
    sheetMode: over.sheetMode ?? COLD.sheetMode,
    sheetTab: over.sheetTab ?? COLD.sheetTab,
    requests: over.requests ?? [],
    runs: over.runs ?? [],
    snapshot: {
      startedAt: over.startedAt ?? cold.startedAt,
      library: {
        polledAt: over.polledAt ?? null,
        syncedAt: null,
        error: over.libraryError ?? null,
        counts: over.counts ?? cold.library.counts,
        poll: over.gate === undefined || over.gate === null ? (over.gate ?? null) : pollOf(over.gate),
        movement: over.movement ?? null,
      },
      feed: {
        events: over.events ?? 0,
        renderedAt: over.renderedAt ?? null,
        servingCached: over.servingCached ?? false,
        error: over.renderError ?? null,
        calendars: {
          attemptedAt: over.calendarsAt ?? null,
          freshAt: over.calendarsAt ?? null,
          changedAt: over.calendarsChangedAt ?? null,
          error: over.calendarError ?? null,
        },
        films: { resolved: over.films ?? 0, resolvedAt: over.filmsResolvedAt ?? null },
      },
      sheet: {
        configured: over.sheetConfigured ?? false,
        status: over.sheetStatus ?? 'idle',
        lastRunAt: over.sheetLastRunAt ?? null,
        frozen: over.sheetFrozen ?? null,
        error: over.sheetError ?? null,
      },
    },
  };
};

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
export const moved = (over: Partial<LibraryMovement> = {}): LibraryMovement => ({
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
