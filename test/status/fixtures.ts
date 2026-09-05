/**
 * The one cold `StatusInput`, shared by the model and render suites. Two
 * copies of a nested literal do not fail to typecheck when they drift, and the
 * suites must describe the same cold page — a field benign in one copy and
 * null in the other lets the render assertion pass over a state the model
 * assertion never saw.
 *
 * `input()` takes the page's knobs by flat name and places each on the nested
 * `Snapshot`, so a test says `input({ renderedAt })` rather than spreading
 * four levels by hand.
 *
 * The `test/**\/*.test.ts` glob never runs this as a suite.
 */

import type { SheetRunRecord } from '../../src/sheet/io/journal.ts';
import type { BaselineSummary } from '../../src/sheet/io/baseline.ts';
import type { RequestRecord } from '../../src/api/requests.ts';
import type { Problem } from '../../src/health.ts';
import type { SheetSyncStatus } from '../../src/sheet/sync.ts';
import type { SheetSyncMode } from '../../src/shared/config.ts';
import type { StatusInput } from '../../src/status/1-model.ts';
import type { FeedEvent } from '../../src/feed/2-join.ts';
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
 * `ms` before `NOW`. Not `helpers.ts`'s `ago`, which counts back from the real
 * clock — importing both is how a test starts measuring against a moving now.
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

/** Stands in for the feed token, which the page prints in both of its links. */
const TOKEN = 'fixture-token';

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
  filmsConfigured: false,
  sheetMode: 'off',
  sheetTab: 'Sheet1',
  filmsTab: 'Movies',
  feedUrl: `http://localhost:3000/${TOKEN}/feed.ics`,
  feedSubscribeUrl: `webcal://localhost:3000/${TOKEN}/feed.ics`,
  sheetUrl: null,
  artwork: null,
  events: [],
  requests: [],
  runs: [],
  baseline: { seasons: 0, films: 0, at: null },
};

/** The page's knobs, by flat name, placed onto the nested input by `input()`. */
export interface InputOver {
  now?: Temporal.Instant;
  ok?: boolean;
  problems?: Problem[];
  activitiesPoll?: Temporal.Duration;
  calendarRefresh?: Temporal.Duration;
  filmsDue?: boolean;
  runtimesConfigured?: boolean;
  filmsConfigured?: boolean;
  sheetMode?: SheetSyncMode;
  sheetTab?: string;
  filmsTab?: string;
  sheetUrl?: string | null;
  artwork?: StatusInput['artwork'];
  requests?: RequestRecord[];
  runs?: SheetRunRecord[];
  /** The feed's own events, which the upcoming list is built from. */
  feedEvents?: FeedEvent[];
  baseline?: BaselineSummary;

  startedAt?: string;
  polledAt?: string | null;
  libraryError?: string | null;
  counts?: LibraryCounts;
  /** Whatever this poll did; everything unnamed is the all-zero quiet poll. */
  gate?: Partial<PollOutcome> | null;
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

/**
 * One poll, all zeros, with whatever the test names raised. Taking the whole
 * `PollOutcome` as a partial rather than listing the fields the page happens to
 * read means a page that starts reading another one needs nothing here.
 */
const pollOf = (over: Partial<PollOutcome>): PollOutcome => ({
  at: before(MINUTE),
  changed: (over.pull ?? 'none') !== 'none',
  pull: 'none',
  removalsChecked: false,
  refusedRemovals: false,
  updated: 0,
  reshaped: 0,
  removed: 0,
  rendered: false,
  ...over,
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
    filmsConfigured: over.filmsConfigured ?? COLD.filmsConfigured,
    sheetMode: over.sheetMode ?? COLD.sheetMode,
    sheetUrl: over.sheetUrl === undefined ? COLD.sheetUrl : over.sheetUrl,
    artwork: over.artwork === undefined ? COLD.artwork : over.artwork,
    sheetTab: over.sheetTab ?? COLD.sheetTab,
    filmsTab: over.filmsTab ?? COLD.filmsTab,
    requests: over.requests ?? [],
    runs: over.runs ?? [],
    events: over.feedEvents ?? [],
    baseline: over.baseline ?? COLD.baseline,
    snapshot: {
      startedAt: over.startedAt ?? cold.startedAt,
      library: {
        polledAt: over.polledAt ?? null,
        syncedAt: null,
        error: over.libraryError ?? null,
        counts: over.counts ?? cold.library.counts,
        poll: over.gate == null ? null : pollOf(over.gate),
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

/**
 * One feed event, at the shape `join` produces. `join` sorts by date, so a
 * list built here is given in the order the page must keep.
 */
export const feedEvent = (ymd: string, over: Partial<FeedEvent> = {}): FeedEvent => ({
  uid: `simkl-${ymd}@simkl-ical`,
  kind: 'tv',
  date: Temporal.PlainDate.from(ymd),
  summary: `Show – ${ymd}`,
  episodeTitle: null,
  detail: null,
  runtime: null,
  url: null,
  ...over,
});

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
export const moved = ({ deltas = [], ...poll }: Partial<LibraryMovement> = {}): LibraryMovement => ({
  ...pollOf({ at: before(2 * MINUTE), pull: 'delta', ...poll }),
  deltas,
});

/** The all-zero counts with the named buckets raised. `libraryCounts(null)` is fresh per call, so mutating it is safe. */
export const countsWith = (byType: Partial<Record<SyncType, Record<string, number>>> = {}, other = 0): LibraryCounts => {
  const counts = libraryCounts(null);
  for (const [type, statuses] of Object.entries(byType)) Object.assign(counts.byType[type as SyncType], statuses);
  counts.other = other;
  return counts;
};
