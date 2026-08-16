/**
 * Shared test fixtures.
 *
 * `withTempDataDir` and `withFetch` exist to stop accidents, not to save
 * typing: `config.dataDir` defaults to ./data, which on a real checkout holds a
 * live OAuth token, and nothing in the suite should reach the real CDN or API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, type Config } from '../src/shared/config.ts';
import { clearSheetRuns } from '../src/sheet/io/journal.ts';

import type { Calendars } from '../src/feed/io/calendar.ts';
import type { SheetSnapshot } from '../src/sheet/io/spreadsheet.ts';
import type { CellData } from '../src/api/google/types.ts';
import type { CalendarEntry, CalendarFile, LibraryItem, ShowMetadata, SyncType } from '../src/api/simkl/types.ts';
import type { Library } from '../src/library.ts';

// Here rather than per file, for the same reason: a file that forgets these
// reaches the real API, or sleeps 15s per retry path.
config.clientId ??= 'test-client-id';
config.retryBase = Temporal.Duration.from({ milliseconds: 1 });
// The same class of guard as withTempDataDir, and not a convenience. SHEET_ID
// lives in .env, config.ts loads it at import, and a test that forgot to
// override would write to the real spreadsheet.
config.sheetId = undefined;
// Same guard, for the feed token: a server test that forgot `withConfig` would
// otherwise authenticate against the live one and pass for the wrong reason.
config.feedToken = undefined;
config.sheetSyncMode = 'off';
config.googleKeyBase64 = undefined;
config.googleCredentialsExplicit = false;
// Same guard, for writes rather than reads. Anything that persists — the feed,
// the sheet run log — lands under config.dataDir, which defaults to ./data and
// on a real checkout holds a live token. A suite that writes there passes green
// while corrupting the thing it was told not to touch, so the default is moved
// somewhere harmless and `withTempDataDir` stays for tests that read it back.
// Per-pid so concurrent test files cannot collide; created only if written to.
config.dataDir = join(tmpdir(), `simkl-ical-suite-${process.pid}`);

/** A logger that records nothing, for states under test. */
export const quiet = { info() {}, warn() {}, error() {} };

/** A logger that keeps what it was told, for asserting on reported failures. */
export const recorder = () => {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => void lines.push(`info: ${m}`),
    warn: (m: string) => void lines.push(`warn: ${m}`),
    error: (m: string) => void lines.push(`error: ${m}`),
  };
};

/**
 * Override config for the duration of `fn`, restoring it afterwards. config is
 * a process-wide singleton, so a missed restore changes behaviour elsewhere.
 */
export const withConfig = async (overrides: Partial<Config>, fn: () => void | Promise<void>): Promise<void> => {
  const keys = Object.keys(overrides) as Array<keyof Config>;
  const previous = Object.fromEntries(keys.map((k) => [k, config[k]])) as Partial<Config>;
  Object.assign(config, overrides);
  try {
    await fn();
  } finally {
    Object.assign(config, previous);
  }
};

/** An ISO timestamp `ms` in the past, for aging a Feed or Orchestrator clock. */
export const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** One calendar's payload, as fetchCalendar would return it. */
export const calendarOf = (calendar: CalendarEntry[] = [], metadata: Record<string, ShowMetadata> = {}): CalendarFile => ({
  calendar,
  metadata,
});

/** A complete, empty, fresh set of calendars — the shape refresh.ts holds. */
export const emptyCalendars = (): Calendars => ({
  tv: { data: calendarOf(), source: 'fresh' },
  anime: { data: calendarOf(), source: 'fresh' },
});

/** Point config.dataDir at a fresh directory for the duration of `fn`. */
export const withTempDataDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'simkl-ical-test-'));
  const original = config.dataDir;
  config.dataDir = dir;
  try {
    await fn(dir);
  } finally {
    config.dataDir = original;
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * A temp data dir *and* an empty run history, which is what a test touching the
 * sheet journal actually needs: the history is a module-level cache, so a suite
 * that only isolates the directory still inherits whatever the last test wrote.
 */
export const withFreshJournal = async (fn: (dir: string) => Promise<void>): Promise<void> =>
  withTempDataDir(async (dir) => {
    clearSheetRuns();
    try {
      await fn(dir);
    } finally {
      clearSheetRuns();
    }
  });

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * The query of a recorded call, decoded. Assertions read the value the API was
 * asked for rather than its percent-encoding, so a change in how `apiGet`
 * builds a query string cannot fail a test that no behaviour change touched.
 */
export const paramsOf = (call: string): URLSearchParams => new URL(call).searchParams;

/**
 * Replace global fetch for the duration of `fn`, recording every URL asked for.
 * The call log is what most tests assert on: that a poll made one request
 * rather than eight, or retried the right number of times.
 */
export const withFetch = async (handler: FetchHandler, fn: (calls: string[]) => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

/** A JSON 200, with an optional Last-Modified so conditional GETs can be tested. */
export const jsonResponse = (body: unknown, { lastModified }: { lastModified?: string } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: lastModified ? { 'content-type': 'application/json', 'last-modified': lastModified } : { 'content-type': 'application/json' },
  });

/** A complete, valid saved feed. `store.test.ts` contrasts truncations against it. */
export const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

/** A minimal but well-formed calendar file. */
export const calendarFile = (calendar: unknown[] = [], metadata: Record<string, unknown> = {}) => ({ calendar, metadata });

// --- Sheet fixtures --------------------------------------------------------

/**
 * A cell, written the way the sheet reads. `{ formula }` is the one that
 * matters: a formula target must be refused unconditionally, and only
 * `userEnteredValue.formulaValue` distinguishes one.
 */
export type CellSpec = string | number | null | { formula: string; value?: string | number };

export const cellOf = (spec: CellSpec): CellData => {
  if (spec === null) return {};
  if (typeof spec === 'object') {
    const result = typeof spec.value === 'number' ? { numberValue: spec.value } : spec.value === undefined ? undefined : { stringValue: spec.value };
    return { userEnteredValue: { formulaValue: spec.formula }, ...(result ? { effectiveValue: result } : {}) };
  }
  const value = typeof spec === 'number' ? { numberValue: spec } : { stringValue: spec };
  return { userEnteredValue: value, effectiveValue: value };
};

/** Today's column order. Tests that care about header resolution shuffle it. */
export const SHEET_HEADERS = ['Show', 'Status', 'Season', 'Episode', 'Start', 'End', 'Episodes', 'Length', 'id', 'Type'];

export const sheetSnapshot = (rows: CellSpec[][], { sheetId = 1, columnCount }: { sheetId?: number; columnCount?: number } = {}): SheetSnapshot => ({
  sheetId,
  title: 'Sheet1',
  rowCount: rows.length,
  columnCount: columnCount ?? Math.max(...rows.map((r) => r.length)),
  rows: rows.map((row) => row.map(cellOf)),
  readAtMono: performance.now(),
});

/**
 * A show row and a season row, in `SHEET_HEADERS` order.
 *
 * Shared rather than re-declared per file: these are positional arrays keyed to
 * the header list, so a column added or reordered means editing every literal
 * correctly — and a missed one shifts every index in that file without failing
 * loudly. The show row's five derived cells are formulas because that is what
 * they are on the real sheet, and the never-write-a-formula guard depends on it.
 */
export const showRow = (title: string, status: string | null, id: number | string | null = null, type = 'show'): CellSpec[] => [
  title,
  status,
  { formula: '=LET(…)', value: 1 },
  { formula: '=LET(…)', value: 6 },
  45000,
  { formula: '=LET(…)' },
  { formula: '=LET(…)' },
  { formula: '=LET(…)' },
  id,
  type,
];

export const seasonRow = (
  season: number,
  episode: number | null,
  end: number | null,
  { id = null, start = 45000 }: { id?: number | string | null; start?: number } = {},
): CellSpec[] => [null, null, season, episode, start, end, 0.0153, { formula: '=G*F' }, id, null];

/** An ISO instant `days` in the past — the cut-off is the gate on everything. */
export const daysAgo = (days: number): string => ago(Temporal.Duration.from({ days }).total('milliseconds'));

export interface ItemSpec {
  id: number;
  /** Films nest under `movie` and carry no seasons; everything else under `show`. */
  type?: SyncType;
  title?: string;
  status?: string;
  lastWatchedAt?: string | null;
  watched?: number;
  total?: number;
  notAired?: number;
  /** Season number → watched timestamps, one per episode. */
  seasons?: Record<number, Array<string | null>>;
}

export const libraryItem = ({ id, type = 'shows', title = `Show ${id}`, status = 'watching', lastWatchedAt, watched, total, notAired = 0, seasons = {} }: ItemSpec): LibraryItem => {
  const episodes = Object.values(seasons).flat();
  const counted = episodes.filter((at) => at !== null).length;
  const nested = { title, ids: { simkl: id } };
  if (type === 'movies') return { movie: nested, status, last_watched_at: lastWatchedAt ?? null };
  return {
    show: nested,
    status,
    last_watched_at: lastWatchedAt ?? episodes.filter((at): at is string => at !== null).sort().at(-1) ?? null,
    watched_episodes_count: watched ?? counted,
    total_episodes_count: total ?? counted,
    not_aired_episodes_count: notAired,
    seasons: Object.entries(seasons).map(([number, watchedAt]) => ({
      number: Number(number),
      episodes: watchedAt.map((at, i) => ({ number: i + 1, watched_at: at })),
    })),
  };
};

/**
 * A library holding the given items, all typed `shows` unless a spec says
 * otherwise. The default matches what most suites want; anything testing the
 * type split sets it per item, since the type is the one field the item itself
 * cannot supply.
 */
export const libraryOf = (...items: ItemSpec[]): Library =>
  new Map(items.map((spec) => [spec.id, { type: spec.type ?? 'shows', item: libraryItem(spec) }]));
