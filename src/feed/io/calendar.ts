/**
 * FETCH — airdates, from the rolling file plus whatever monthly archives the
 * grace window reaches, merged.
 *
 * First of **FETCH** → JOIN → RENDER → SAVE, alongside `movies.ts`.
 */

import { config } from '../../shared/config.ts';
import { localDate } from '../../shared/dates.ts';
import { errorMessage } from '../../shared/errors.ts';
import { withTimeout } from '../../shared/signals.ts';
import type { CalendarFile, CalendarType } from '../../api/simkl/types.ts';

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

interface FetchResult extends FetchedFile {
  /**
   * The network failed and the cached copy was served instead, so health can
   * tell an outage from a quiet CDN. A 304 is not stale: the CDN answered.
   */
  stale: boolean;
}

/**
 * Process-lifetime cache, deliberately not on disk: it makes the 3-hourly
 * conditional GET cheap, while a restart always resyncs from the CDN.
 */
const cache = new Map<string, FetchedFile>();

/** Cache keys currently held. Exported for tests; nothing in src/ reads it. */
export const cachedKeys = (): string[] => [...cache.keys()];

/** Drop everything. Exported for tests, which must not share a cache. */
export const clearCache = (): void => cache.clear();

/**
 * Fetch a calendar JSON file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings, so cache-busting is impossible and a conditional
 * GET against the stored Last-Modified is the only way to tell whether a
 * regeneration has actually happened.
 */
const fetchCached = async (url: string, key: string, { signal }: { signal?: AbortSignal } = {}): Promise<FetchResult> => {
  const cached = cache.get(key) ?? null;
  const headers: Record<string, string> = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  // A stale calendar beats no calendar, so every failure below serves the cache
  // when there is one — flagged stale rather than passing as a success.
  const fallback = (reason: string): FetchResult => {
    if (cached) return { ...cached, stale: true };
    throw new Error(`Calendar ${url} ${reason}`);
  };

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default. The throw is caught for the same reason a bad status is: a
  // timeout, a DNS failure or a reset are the *likeliest* ways the CDN fails,
  // and letting one escape past `fallback` discards a perfectly good cached
  // month — silently, because the caller reads staleness off the rolling file.
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: withTimeout(signal, FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fallback(`could not be fetched: ${errorMessage(err)}`);
  }

  if (res.status === 304 && cached) return { ...cached, stale: false };
  if (!res.ok) return fallback(`returned ${res.status}`);

  let data: CalendarFile;
  try {
    data = (await res.json()) as CalendarFile;
  } catch (err) {
    // An HTML interstitial served with a 200 must not discard a good cache.
    return fallback(`returned unparseable JSON: ${errorMessage(err)}`);
  }

  // Parseable is not usable: a 200 carrying `{}` or an error object would
  // replace a good cache entry and render a near-empty feed.
  if (!Array.isArray(data.calendar)) return fallback('returned JSON with no calendar array');

  const entry: FetchedFile = { data, lastModified: res.headers.get('last-modified') };
  cache.set(key, entry);
  return { ...entry, stale: false };
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

const rollingKey = (type: CalendarType): string => `calendar-${type}`;
const archiveKey = (type: CalendarType, year: number, month: number): string => `calendar-${type}-${year}-${month}`;

export const fetchRolling = (type: CalendarType, { signal }: { signal?: AbortSignal } = {}): Promise<FetchResult> =>
  fetchCached(rollingUrl(type), rollingKey(type), { signal });

const fetchArchive = (
  type: CalendarType,
  year: number,
  month: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<FetchResult> => fetchCached(archiveUrl(type, year, month), archiveKey(type, year, month), { signal });

export interface YearMonth {
  year: number;
  month: number;
}

/**
 * Distinct {year, month} pairs spanned by the last `days` days, oldest first.
 *
 * Counted from the **local** date, because the join's cutoff is
 * `localDate(now) - graceDays` and the two must agree about which months the
 * window reaches. Counting in UTC instead loses up to a day of grace in any
 * behind-UTC zone near a month boundary: at 2026-03-15T02:00Z in
 * America/New_York the local cutoff is 2026-02-28, but a UTC window from the
 * 15th spans March alone — so an entry dated 2026-02-28T23:00Z passes the
 * join's filter while living in a February archive nothing ever fetched.
 */
export const monthsBack = (days: number, now: Date = new Date(), timezone: string = config.timezone): YearMonth[] => {
  const [year, month, day] = localDate(now.toISOString(), timezone).split('-').map(Number) as [number, number, number];
  const months = new Map<string, YearMonth>();
  for (let i = days; i >= 0; i -= 1) {
    // Plain calendar arithmetic on a plain date: the zone was applied above,
    // and applying it twice is how an off-by-one gets in.
    const d = new Date(Date.UTC(year, month - 1, day - i));
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
      // Keyed on the date when there is no `episode` object — some anime
      // entries have none, and season/episode alone would collapse them all.
      const episodeKey = entry.episode ? `${entry.episode.season}-${entry.episode.episode}` : entry.date;
      entries.set(`${entry.simkl_id}-${episodeKey}`, entry);
    }
    Object.assign(metadata, part?.metadata ?? {});
  }

  return { calendar: [...entries.values()], metadata };
};

export interface CalendarOptions {
  graceDays?: number;
  /** The zone the grace window is measured in — the join's, necessarily. */
  timezone?: string;
  signal?: AbortSignal;
  now?: Date;
  /** Optional sink for problems that degrade the result without failing it. */
  log?: (message: string) => void;
}

/**
 * A fetched calendar and how fresh it is. Freshness sits beside the payload
 * rather than on it — simkl/types.ts holds only shapes SIMKL actually sends.
 */
export interface CalendarResult {
  data: CalendarFile;
  stale: boolean;
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
  { graceDays = config.graceDays, timezone = config.timezone, signal, now = new Date(), log }: CalendarOptions = {},
): Promise<CalendarResult> => {
  if (!CALENDAR_FILES[type]) throw new Error(`Unknown calendar type: ${type}`);

  const months = graceDays > ROLLING_PAST_DAYS ? monthsBack(graceDays, now, timezone) : [];

  // Safe to parallelise: unauthenticated and CDN-cached. SIMKL's warning
  // against it covers the authenticated sync endpoints, not these.
  const archives = await Promise.all(
    months.map(async ({ year, month }) => {
      try {
        return (await fetchArchive(type, year, month, { signal })).data;
      } catch (err) {
        // A missing archive only narrows the window. Logged because a shorter
        // grace window looks identical to a feed with nothing old to show.
        log?.(`archive ${year}/${month} ${type} unavailable, grace window narrowed: ${errorMessage(err)}`);
        return null;
      }
    }),
  );

  // Only the rolling file's freshness matters: a closed month's archive never
  // changes, so serving one from cache is not staleness.
  const rolling = await fetchRolling(type, { signal });
  // Rolling last so it wins on overlap; Promise.all preserves input order.
  const parts: Array<CalendarFile | null> = [...archives, rolling.data];

  evictOutside([rollingKey(type), ...months.map((m) => archiveKey(type, m.year, m.month))], type);

  return { data: mergeCalendars(parts), stale: rolling.stale };
};

/**
 * Drop cached files outside the current window. The cache is keyed per archive
 * month, and each retained month costs roughly 4 MB for the life of the process.
 */
const evictOutside = (keep: string[], type: CalendarType): void => {
  const wanted = new Set(keep);
  for (const key of cache.keys()) {
    if (key.startsWith(`calendar-${type}`) && !wanted.has(key)) cache.delete(key);
  }
};

export type Calendars = Record<CalendarType, CalendarResult>;

/** All calendar types. Safe to parallelise: CDN-cached, unauthenticated. */
export const fetchAllCalendars = async ({ graceDays = config.graceDays, timezone = config.timezone, signal, now, log }: CalendarOptions = {}): Promise<Calendars> => {
  const types = Object.keys(CALENDAR_FILES) as CalendarType[];
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { graceDays, timezone, signal, now, log })));
  return Object.fromEntries(types.map((t, i) => [t, results[i]!])) as Calendars;
};

/** True when any calendar was served from cache after the CDN failed. */
export const anyStale = (calendars: Calendars): boolean => Object.values(calendars).some((c) => c.stale);

/** Just the payloads, for the join, which has no use for freshness. */
export const payloads = (calendars: Calendars): Record<CalendarType, CalendarFile> =>
  Object.fromEntries(Object.entries(calendars).map(([type, result]) => [type, result.data])) as Record<CalendarType, CalendarFile>;
