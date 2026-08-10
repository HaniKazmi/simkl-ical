import { config } from '../config.ts';
import { errorMessage } from '../errors.ts';
import type { CalendarFile, CalendarType, MergedCalendar } from '../simkl/types.ts';

const CDN_BASE = 'https://data.simkl.in/calendar/v2/';

/**
 * Calendar file per content type. Anime is a separate type in SIMKL, not a show genre.
 *
 * movie_release.json is deliberately absent: it only covers a rolling 33-day
 * window and carries a date-only 04:00Z placeholder, so films are resolved
 * per-title through /movies/{id} instead — see sources/movies.ts.
 */
export const CALENDAR_FILES: Record<CalendarType, string> = {
  tv: 'tv.json',
  anime: 'anime.json',
};

/** The rolling file spans roughly -2/+34 days; beyond that we need archives. */
const ROLLING_PAST_DAYS = 2;

/** Archives run to several MB, so this is generous rather than tight. */
const FETCH_TIMEOUT_MS = 60_000;

interface FetchedFile {
  data: CalendarFile;
  lastModified: string | null;
}

/**
 * Process-lifetime cache, deliberately not on disk.
 *
 * It exists to make the 3-hourly conditional GET cheap — without it every
 * refresh would re-download several MB. Keeping it in memory means a restart
 * always resyncs from the CDN, which costs about a second and removes any
 * possibility of stale state outliving the process.
 */
const cache = new Map<string, FetchedFile>();

/** Test seam: drop everything so a fetch behaves like a cold start. */
export const clearCalendarCache = (): void => cache.clear();

/**
 * Fetch a calendar JSON file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings, so cache-busting is impossible and a conditional
 * GET against the stored Last-Modified is the only way to tell whether a
 * regeneration has actually happened.
 */
const fetchCached = async (url: string, key: string, { signal }: { signal?: AbortSignal } = {}): Promise<FetchedFile> => {
  const cached = cache.get(key) ?? null;
  const headers: Record<string, string> = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default.
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const fallback = (): FetchedFile | null => cached;

  if (res.status === 304 && cached) return cached;
  if (!res.ok) {
    // A stale calendar beats no calendar. Only fail if there is nothing to fall back to.
    const stale = fallback();
    if (stale) return stale;
    throw new Error(`Calendar ${url} returned ${res.status}`);
  }

  let data: CalendarFile;
  try {
    data = (await res.json()) as CalendarFile;
  } catch (err) {
    // A 200 carrying an HTML interstitial would otherwise discard a good cache.
    const stale = fallback();
    if (stale) return stale;
    throw new Error(`Calendar ${url} returned unparseable JSON: ${errorMessage(err)}`);
  }

  const entry: FetchedFile = { data, lastModified: res.headers.get('last-modified') };
  cache.set(key, entry);
  return entry;
};

export const rollingUrl = (type: CalendarType): string => CDN_BASE + CALENDAR_FILES[type];

/**
 * Monthly archive URL.
 *
 * The month is NOT zero-padded: /2026/8/tv.json returns 200 while /2026/08/tv.json
 * returns 404. This is the one trap in the archive API.
 */
export const archiveUrl = (type: CalendarType, year: number, month: number): string =>
  `${CDN_BASE}${year}/${month}/${CALENDAR_FILES[type]}`;

export const fetchRolling = (type: CalendarType, { signal }: { signal?: AbortSignal } = {}): Promise<FetchedFile> =>
  fetchCached(rollingUrl(type), `calendar-${type}`, { signal });

export const fetchArchive = (
  type: CalendarType,
  year: number,
  month: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<FetchedFile> => fetchCached(archiveUrl(type, year, month), `calendar-${type}-${year}-${month}`, { signal });

export interface YearMonth {
  year: number;
  month: number;
}

/** Distinct {year, month} pairs spanned by the last `days` days, oldest first. */
export const monthsBack = (days: number, now: Date = new Date()): YearMonth[] => {
  const months = new Map<string, YearMonth>();
  for (let i = days; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    // Unpadded month, matching the archive URL scheme.
    months.set(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`, {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
    });
  }
  return [...months.values()];
};

/** Merge calendar files, later sources winning on conflict. */
export const mergeCalendars = (parts: Array<CalendarFile | null | undefined>): CalendarFile => {
  const entries = new Map<string, CalendarFile['calendar'][number]>();
  const metadata: CalendarFile['metadata'] = {};

  for (const part of parts) {
    for (const entry of part?.calendar ?? []) {
      // The date is part of the key because entries without an `episode`
      // object exist: keying on season/episode alone collapsed every undated
      // airing of a show onto one slot before the join ever saw them.
      const episodeKey = entry.episode ? `${entry.episode.season}-${entry.episode.episode}` : entry.date;
      entries.set(`${entry.simkl_id}-${episodeKey}`, entry);
    }
    Object.assign(metadata, part?.metadata ?? {});
  }

  return { calendar: [...entries.values()], metadata };
};

export interface CalendarOptions {
  graceDays?: number;
  signal?: AbortSignal;
  now?: Date;
}

/**
 * One content type's calendar, widened backwards to cover the grace window.
 *
 * The rolling file only reaches about two days into the past, so a longer grace
 * window needs the monthly archives. Archives are merged first and the rolling
 * file last, so the freshest data wins on any overlap.
 */
export const fetchCalendar = async (
  type: CalendarType,
  { graceDays = config.graceDays, signal, now = new Date() }: CalendarOptions = {},
): Promise<MergedCalendar> => {
  if (!CALENDAR_FILES[type]) throw new Error(`Unknown calendar type: ${type}`);

  const parts: CalendarFile[] = [];

  if (graceDays > ROLLING_PAST_DAYS) {
    for (const { year, month } of monthsBack(graceDays, now)) {
      try {
        parts.push((await fetchArchive(type, year, month, { signal })).data);
      } catch {
        // A missing archive just narrows the window; the rolling file still works.
      }
    }
  }

  const rolling = await fetchRolling(type, { signal });
  parts.push(rolling.data);

  return { ...mergeCalendars(parts), type, lastModified: rolling.lastModified };
};

export type Calendars = Record<CalendarType, MergedCalendar>;

/** All calendar types. Safe to parallelise: CDN-cached, unauthenticated. */
export const fetchAllCalendars = async ({ graceDays = config.graceDays, signal, now }: CalendarOptions = {}): Promise<Calendars> => {
  const types = Object.keys(CALENDAR_FILES) as CalendarType[];
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { graceDays, signal, now })));
  return Object.fromEntries(results.map((r) => [r.type, r])) as Calendars;
};
