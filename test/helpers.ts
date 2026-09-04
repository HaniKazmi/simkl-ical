/**
 * Shared test fixtures. `withTempDataDir` and `withFetch` stop accidents, not
 * typing: `config.dataDir` defaults to ./data, which on a real checkout holds
 * a live OAuth token, and nothing in the suite may reach the real CDN or API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, type Config } from '../src/shared/config.ts';
import { clearSheetRuns } from '../src/sheet/io/journal.ts';
import { clearBaseline } from '../src/sheet/io/baseline.ts';
import { dateSerial } from '../src/sheet/values.ts';

import type { Calendars } from '../src/feed/io/calendar.ts';
import type { SheetSnapshot } from '../src/sheet/io/spreadsheet.ts';
import type { CellData } from '../src/api/google/types.ts';
import type { CalendarEntry, CalendarFile, LibraryItem, ShowMetadata, SyncType } from '../src/api/simkl/types.ts';
import type { Library } from '../src/library.ts';
import { isoOf, plainDateIn } from '../src/shared/dates.ts';

// Set here rather than per file: a file that forgets these reaches the real
// API, or sleeps 15s per retry path.
config.clientId ??= 'test-client-id';
config.retryBase = Temporal.Duration.from({ milliseconds: 1 });
// SHEET_ID lives in .env and config.ts loads it at import; a test that forgot
// to override would write to the real spreadsheet.
config.sheetId = undefined;
// Same guard for the feed token: a server test that forgot `withConfig` would
// authenticate against the live one and pass for the wrong reason.
config.feedToken = undefined;
config.sheetSyncMode = 'off';
config.googleKeyBase64 = undefined;
config.googleCredentialsExplicit = false;
// Same guard: TVDB_API_KEY lives in .env, and a forgotten override would
// reach the live API.
config.tvdbApiKey = undefined;
config.tvdbPin = undefined;
// Same guard: TMDB_API_KEY lives in .env too, and `apiGet` throws without it,
// so a test that forgot `withFetch` fails loudly rather than reaching the live
// API on someone's quota.
config.tmdbApiKey = undefined;
// Same guard, for writes: everything that persists lands under config.dataDir,
// which defaults to ./data and holds a live token on a real checkout. The
// default moves somewhere harmless; `withTempDataDir` stays for tests that
// read it back. Per-pid so concurrent files cannot collide; created only if
// written to.
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
 * Override config for the duration of `fn`, then restore. config is a
 * process-wide singleton; a missed restore changes behaviour elsewhere.
 *
 * The sheet baseline is emptied here for the same reason, and automatically
 * rather than by invitation: it is a module-level singleton that *decides*
 * whether cells get written, so a run that inherits the last test's
 * observations plans edits against values this test never set up. A test that
 * wants a baseline seeds it inside `fn`, where this has already cleared it.
 */
export const withConfig = async (overrides: Partial<Config>, fn: () => void | Promise<void>): Promise<void> => {
  const keys = Object.keys(overrides) as Array<keyof Config>;
  const previous = Object.fromEntries(keys.map((k) => [k, config[k]])) as Partial<Config>;
  Object.assign(config, overrides);
  clearBaseline();
  try {
    await fn();
  } finally {
    Object.assign(config, previous);
    clearBaseline();
  }
};

/** An ISO timestamp `ms` in the past, for aging a Feed or Orchestrator clock. */
export const ago = (ms: number): string => isoOf(Temporal.Now.instant().subtract({ milliseconds: ms }));

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
 * A temp data dir *and* an empty run history: the history is a module-level
 * cache, so isolating only the directory still inherits the last test's runs.
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

/**
 * The same, for the baseline. `withConfig` already clears it for every test
 * that runs a sync, but a test driving `io/baseline.ts` directly needs the temp
 * dir too — and the isolation rule belongs beside its twin rather than private
 * to one file, where the next `io/` test would copy it a third time.
 */
export const withFreshBaseline = async (fn: (dir: string) => Promise<void>): Promise<void> =>
  withTempDataDir(async (dir) => {
    clearBaseline();
    try {
      await fn(dir);
    } finally {
      clearBaseline();
    }
  });

/**
 * Today's serial in `zone` — the bound a recent watch must sit under, and the
 * one `fixture.ts`'s UTC `TODAY` cannot give a suite running in another zone.
 */
export const todaySerial = (zone: string): number => dateSerial(plainDateIn(Temporal.Now.instant(), zone));

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * The query of a recorded call, decoded: assertions read the value asked for,
 * not its percent-encoding, so a change in how `apiGet` builds a query string
 * cannot fail an unrelated test.
 */
export const paramsOf = (call: string): URLSearchParams => new URL(call).searchParams;

/**
 * Replace global fetch for the duration of `fn`, recording every URL. Most
 * tests assert on the call log: one request rather than eight, or the right
 * number of retries.
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
 * A cell, as the sheet reads it. `{ formula }` is the one that matters: a
 * formula target must be refused unconditionally, and only
 * `userEnteredValue.formulaValue` distinguishes one.
 */
export type CellSpec = string | number | boolean | null | { formula: string; value?: string | number };

export const cellOf = (spec: CellSpec): CellData => {
  if (spec === null) return {};
  if (typeof spec === 'object') {
    const result = typeof spec.value === 'number' ? { numberValue: spec.value } : spec.value === undefined ? undefined : { stringValue: spec.value };
    return { userEnteredValue: { formulaValue: spec.formula }, ...(result ? { effectiveValue: result } : {}) };
  }
  // A boolean is its own `ExtendedValue` member, not a stringified one: the
  // films tab's `Cinema` and `Anime` cells hold `boolValue: true`, and a
  // `"TRUE"` string is a different cell to every comparison in the sync.
  const value =
    typeof spec === 'number' ? { numberValue: spec } : typeof spec === 'boolean' ? { boolValue: spec } : { stringValue: spec };
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
 * A show row and a season row, in `SHEET_HEADERS` order. Shared rather than
 * per file: these are positional arrays keyed to the header list, and a missed
 * edit shifts every index in a file without failing loudly. The show row's
 * derived cells are formulas, as on the real sheet — the never-write-a-formula
 * guard depends on it.
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

/**
 * `episodes` is the per-episode runtime as a day fraction; `null` leaves the
 * cell blank — the one state the runtime write may fill. An option rather than
 * a positional argument, because a name cannot drift the way a position can.
 */
export const seasonRow = (
  season: number,
  episode: number | null,
  end: number | null,
  { id = null, start = 45000, episodes = 0.0153, status = null }: { id?: number | string | null; start?: number; episodes?: number | null; status?: string | null } = {},
): CellSpec[] => [null, status, season, episode, start, end, episodes, { formula: '=G*F' }, id, null];

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
  /** Films only: SIMKL sends the TMDB id as a string, the way it sends the TVDB one. */
  tmdb?: string | null;
  /** Films only: the user's own score, and null where they have not rated it. */
  rating?: number | null;
  /** Films only: whole minutes, the figure the tab's `Runtime` column holds. */
  runtime?: number | null;
}

export const libraryItem = ({
  id,
  type = 'shows',
  title = `Show ${id}`,
  status = 'watching',
  lastWatchedAt,
  watched,
  total,
  notAired = 0,
  seasons = {},
  tmdb = String(id),
  rating = null,
  runtime = 100,
}: ItemSpec): LibraryItem => {
  const episodes = Object.values(seasons).flat();
  const counted = episodes.filter((at) => at !== null).length;
  const nested = { title, ids: { simkl: id } };
  if (type === 'movies') {
    return {
      movie: { title, runtime, ids: { simkl: id, ...(tmdb === null ? {} : { tmdb }) } },
      status,
      last_watched_at: lastWatchedAt ?? null,
      user_rating: rating,
    };
  }
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
 * A library of the given items, typed `shows` unless a spec says otherwise —
 * the type is the one field the item itself cannot supply.
 */
export const libraryOf = (...items: ItemSpec[]): Library =>
  new Map(items.map((spec) => [spec.id, { type: spec.type ?? 'shows', item: libraryItem(spec) }]));

/**
 * The films tab's column order today. Tests that care about header resolution
 * shuffle it; nothing else may depend on the positions.
 */
export const MOVIE_SHEET_HEADERS = [
  'Name',
  'Watch Date',
  'Score',
  'Cinema',
  'Runtime',
  'Genre',
  'Genres',
  'Rating',
  'Release Date',
  'Franchise',
  'Director',
  'id',
  'Anime',
  'Banner',
];

export interface FilmRowSpec {
  name?: string;
  /** A date serial, the way the tab stores it. */
  watched?: number | null;
  score?: number | null;
  cinema?: boolean;
  runtime?: number | null;
  genre?: string | null;
  genres?: string | null;
  rating?: number | null;
  released?: number | null;
  franchise?: string | null;
  director?: string | null;
  /** Text, matching what all 348 live rows hold. A number here is a different cell. */
  id?: string | number | null;
  anime?: boolean;
  banner?: string | null;
}

/** One film row, in `MOVIE_SHEET_HEADERS` order. */
export const filmRow = ({
  name = 'A Film',
  watched = 45000,
  score = null,
  cinema = false,
  runtime = null,
  genre = null,
  genres = null,
  rating = null,
  released = null,
  franchise = null,
  director = null,
  id = null,
  anime = false,
  banner = null,
}: FilmRowSpec = {}): CellSpec[] => [
  name,
  watched,
  score,
  // `null` is a blank cell and `true` a real boolean — the tab spells "no" as
  // an absent cell and never as FALSE, so there is no `false` case to build.
  cinema ? true : null,
  runtime,
  genre,
  genres,
  rating,
  released,
  franchise,
  director,
  id === null ? null : String(id),
  anime ? true : null,
  banner,
];
