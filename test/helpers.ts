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
import { clearHardcoverToken } from '../src/api/hardcover/client.ts';
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
// Same guard, and one with a golden behind it: with a bucket set the films
// insert writes a static bucket link rather than a TMDB URL, so a leaked
// ARTWORK_MOVIE_BUCKET would fail the films golden for the wrong reason.
config.artworkMovieBucket = undefined;
config.artworkShowBucket = undefined;
config.artworkBookBucket = undefined;
config.artworkPublicAcl = false;
// Same guard, and the sharpest of them: HARDCOVER_TOKEN_PATH names a file on
// disk, so a leaked one would spend a real daily quota rather than merely
// reaching an API. Blanked, `graphql` throws before any fetch.
config.booksSheetName = undefined;
config.hardcoverTokenPath = undefined;
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
  clearHardcoverToken();
  try {
    await fn();
  } finally {
    Object.assign(config, previous);
    clearBaseline();
  clearHardcoverToken();
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
  clearHardcoverToken();
    try {
      await fn(dir);
    } finally {
      clearBaseline();
  clearHardcoverToken();
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
  // A boolean is its own `ExtendedValue` member, not a stringified one — kept
  // so a guard test can prove a `boolValue` cell is refused where the tab now
  // holds a string (`Format`, `Type`).
  const value =
    typeof spec === 'number' ? { numberValue: spec } : typeof spec === 'boolean' ? { boolValue: spec } : { stringValue: spec };
  return { userEnteredValue: value, effectiveValue: value };
};

/**
 * The live show tab's 17 labels, in order (A..Q). Tests that care about header
 * resolution shuffle it; nothing else may depend on the positions.
 */
export const SHEET_HEADERS = [
  'Title',
  'Franchise',
  'Genre',
  'Other Genres',
  'Network',
  'Certificate',
  'Type',
  'Status',
  'Season',
  'Subtitle',
  'Episodes',
  'Episode Length (min)',
  'Start Date',
  'End Date',
  'Seasons / Last Watched',
  'ID',
  'Artwork',
];

/**
 * The live films tab's 16 labels, in order (A..P).
 */
export const MOVIE_SHEET_HEADERS = [
  'Title',
  'Series',
  'Series #',
  'Franchise',
  'Director',
  'Genre',
  'Other Genres',
  'Certificate',
  'Format',
  'Release Date',
  'Watch Date',
  'Runtime (min)',
  'Score',
  'Type',
  'ID',
  'Artwork',
];

/**
 * A label's position in a header list, or a hard failure. Every `.indexOf` on
 * a header list is a silent trap under label headers: `indexOf('Episodes')`
 * on the show tab points at the episode *count* column, not the runtime one a
 * reader of the field id expects, and `indexOf('End')` finds no such label and
 * returns -1, so a `row[-1]?.userEnteredValue === undefined` assertion built
 * on it passes for a reason that has nothing to do with what it claims to
 * test.
 */
export const col = (headers: readonly string[], label: string): number => {
  const index = headers.indexOf(label);
  if (index === -1) throw new Error(`no column labelled "${label}" in ${JSON.stringify(headers)}`);
  return index;
};

/**
 * A full-width row built by label rather than position: `null` for every
 * column a spec omits, and a hard failure for a key naming no column — the
 * same fail-loud `col` gives a single lookup.
 */
export const rowByLabel = (headers: readonly string[], cells: Partial<Record<string, CellSpec>>): CellSpec[] => {
  const row = new Array<CellSpec>(headers.length).fill(null);
  for (const [label, value] of Object.entries(cells)) row[col(headers, label)] = value ?? null;
  return row;
};

/**
 * `rowCount` is the *declared* grid, which on a real tab runs well past the
 * rows that hold anything — the live films tab declares 999 for 350 rows of
 * data, and that headroom is what an insert lands in. Defaulted with room for
 * the same reason: a fixture whose grid stops at its last row cannot express
 * an append, so a bound checked against it would look wrong when it is right.
 */
export const sheetSnapshot = (
  rows: CellSpec[][],
  { sheetId = 1, columnCount, rowCount }: { sheetId?: number; columnCount?: number; rowCount?: number } = {},
): SheetSnapshot => ({
  sheetId,
  title: 'Shows',
  rowCount: rowCount ?? rows.length + 10,
  columnCount: columnCount ?? Math.max(...rows.map((r) => r.length)),
  rows: rows.map((row) => row.map(cellOf)),
  readAtMono: performance.now(),
});

/**
 * A show row, in `SHEET_HEADERS` order. Shared rather than per file: these are
 * label-keyed rows and a missed edit shifts every index in a file without
 * failing loudly. The five derived cells are formulas, as on the real sheet —
 * the never-write-a-formula guard depends on it — and `Episode Length (min)`
 * is blank, as measured on all 309 live show rows.
 */
export const showRow = (
  title: string,
  status: string | null,
  id: number | string | null = null,
  type = 'show',
  { artwork = null, franchise = null }: { artwork?: string | null; franchise?: string | null } = {},
): CellSpec[] =>
  rowByLabel(SHEET_HEADERS, {
    Title: title,
    Franchise: franchise,
    Type: type,
    Status: status,
    Season: { formula: '=IF($O2=0,"",OFFSET($I2,$O2,0))', value: 1 },
    Episodes: { formula: '=IF($O2=0,"",SUM(OFFSET($K2,1,0,$O2)))', value: 6 },
    'Start Date': { formula: '=IF($O2=0,"",LET(r,OFFSET($M2,1,0,$O2),IF(COUNT(r)=0,"",MIN(r))))', value: 45000 },
    'End Date': { formula: '=IF($O2=0,"",LET(r,OFFSET($N2,1,0,$O2),IF(COUNT(r)=0,"",MAX(r))))', value: 45010 },
    'Seasons / Last Watched': { formula: '=IFERROR(MATCH("*",OFFSET($A2,1,0,40),0)-1,COUNTA(OFFSET($I2,1,0,40)))', value: 2 },
    ID: id,
    Artwork: artwork,
  });

/**
 * A season row, in `SHEET_HEADERS` order. `runtime: null` leaves the cell
 * blank — the one state the runtime write may fill — and `note` is the
 * last-watched date text; `Status` is always blank on a season row, the
 * meaning it never carries any more.
 */
export const seasonRow = (
  season: number,
  episode: number | null,
  end: number | null,
  { id = null, start = 45000, runtime = 45, note = null }: { id?: number | string | null; start?: number; runtime?: number | null; note?: string | null } = {},
): CellSpec[] =>
  rowByLabel(SHEET_HEADERS, {
    Status: null,
    Season: season,
    Episodes: episode,
    'Episode Length (min)': runtime,
    'Start Date': start,
    'End Date': end,
    'Seasons / Last Watched': note,
    ID: id,
  });

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
  /** Shows only: the TVDB id, as the string SIMKL sends. Absent by default, as it is off `simkl_ids_only`. */
  tvdb?: string;
  /** Films only: the user's own score, and null where they have not rated it. */
  rating?: number | null;
  /** Films only: whole minutes, the figure the tab's `Runtime` column holds. */
  runtime?: number | null;
  /**
   * `anime` records only, and a **top-level** key beside `show` — the one thing
   * separating a film from a cour.
   */
  animeType?: string;
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
  tvdb,
  rating = null,
  runtime = 100,
  animeType,
}: ItemSpec): LibraryItem => {
  const episodes = Object.values(seasons).flat();
  const counted = episodes.filter((at) => at !== null).length;
  // An anime record nests under `show` like any other, and carries the same
  // `runtime` and TMDB id a film record does — whatever its `anime_type`, so a
  // test excluding an `ova` is testing the filter and not a missing field.
  const nested =
    type === 'anime'
      ? { title, runtime, ids: { simkl: id, ...(tmdb === null ? {} : { tmdb }), ...(tvdb === undefined ? {} : { tvdb }) } }
      : { title, ids: { simkl: id, ...(tvdb === undefined ? {} : { tvdb }) } };
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
    ...(animeType === undefined ? {} : { anime_type: animeType }),
    status,
    // On every library record, not just films — and an anime film's score is
    // read off it the same way an ordinary film's is.
    user_rating: rating,
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

export interface FilmRowSpec {
  name?: string;
  /** A date serial, the way the tab stores it. */
  watched?: number | null;
  score?: number | null;
  /** `Cinema` or `Home`, always present on a real row; default `Home`. */
  format?: 'Cinema' | 'Home' | null;
  runtime?: number | null;
  genre?: string | null;
  genres?: string | null;
  rating?: number | null;
  released?: number | null;
  franchise?: string | null;
  director?: string | null;
  /** Text, matching what all 366 live rows hold. A number here is a different cell. */
  id?: string | number | null;
  /** `film` or `anime`, always present on a real row; default `film`. */
  type?: 'film' | 'anime' | null;
  /** The field id `bannerFor`/the guard use — the tab's `Artwork` cell. */
  banner?: string | null;
  series?: string | null;
  seriesNumber?: string | number | null;
}

/** One film row, in `MOVIE_SHEET_HEADERS` order. */
export const filmRow = ({
  name = 'A Film',
  watched = 45000,
  score = null,
  format = 'Home',
  runtime = null,
  genre = null,
  genres = null,
  rating = null,
  released = null,
  franchise = null,
  director = null,
  id = null,
  type = 'film',
  banner = null,
  series = null,
  seriesNumber = null,
}: FilmRowSpec = {}): CellSpec[] =>
  rowByLabel(MOVIE_SHEET_HEADERS, {
    Title: name,
    Series: series,
    'Series #': seriesNumber,
    Franchise: franchise,
    Director: director,
    Genre: genre,
    'Other Genres': genres,
    Certificate: rating,
    Format: format,
    'Release Date': released,
    'Watch Date': watched,
    'Runtime (min)': runtime,
    Score: score,
    Type: type,
    ID: id === null ? null : String(id),
    Artwork: banner,
  });

/** The books tab's live header row, in order. */
export const BOOK_SHEET_HEADERS = [
  'Title',
  'Author',
  'Series',
  'Series #',
  'Franchise',
  'Genre',
  'Format',
  'Release Date',
  'Start Date',
  'End Date',
  'Pages',
  'Hours',
  'Status',
  'Score',
  'ID',
  'Artwork',
];

export interface BookRowSpec {
  name?: string | null;
  author?: string | null;
  franchise?: string | null;
  /** Date serials, the way the tab stores them. */
  released?: number | null;
  started?: number | null;
  ended?: number | null;
  /**
   * A **number**, matching all 401 live rows — where every id on the films tab
   * is text. Both must parse, so a test may pass either.
   */
  id?: string | number | null;
  /** The tab's `Artwork` cell. */
  banner?: string | null;
  series?: string | null;
  seriesNumber?: string | number | null;
  status?: string | null;
}

/** One book row, in `BOOK_SHEET_HEADERS` order. */
export const bookRow = ({
  name = 'A Book',
  author = 'An Author',
  franchise = null,
  released = null,
  started = null,
  ended = 40000,
  id = null,
  banner = null,
  series = null,
  seriesNumber = null,
  status = 'Finished',
}: BookRowSpec = {}): CellSpec[] =>
  rowByLabel(BOOK_SHEET_HEADERS, {
    Title: name,
    Author: author,
    Series: series,
    'Series #': seriesNumber,
    Franchise: franchise,
    'Release Date': released,
    'Start Date': started,
    'End Date': ended,
    Status: status,
    ID: id,
    Artwork: banner,
  });
