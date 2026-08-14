import { config } from '../config.ts';
import { errorMessage } from '../errors.ts';
import { withTimeout } from '../signals.ts';
import type { CalendarFile, CalendarType } from '../simkl/types.ts';

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
   * True when the network failed and the cached copy was served instead.
   *
   * Without this the fallback below is indistinguishable from success, and a
   * CDN that has been down for a month reports as healthy while the feed
   * quietly empties out. A 304 is NOT stale: the CDN answered and confirmed
   * the file has not changed.
   */
  stale: boolean;
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

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default.
  const res = await fetch(url, { headers, signal: withTimeout(signal, FETCH_TIMEOUT_MS) });

  // A stale calendar beats no calendar, so every failure below falls back to the
  // cache when there is one — but says so, rather than passing as a success.
  const fallback = (reason: string): FetchResult => {
    if (cached) return { ...cached, stale: true };
    throw new Error(`Calendar ${url} ${reason}`);
  };

  if (res.status === 304 && cached) return { ...cached, stale: false };
  if (!res.ok) return fallback(`returned ${res.status}`);

  let data: CalendarFile;
  try {
    data = (await res.json()) as CalendarFile;
  } catch (err) {
    // A 200 carrying an HTML interstitial would otherwise discard a good cache.
    return fallback(`returned unparseable JSON: ${errorMessage(err)}`);
  }

  // Parseable is not the same as usable. A 200 carrying `{}` or an error object
  // would otherwise replace a good cache entry, render a near-empty feed, and
  // get persisted over the last good copy.
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
  /** Optional sink for problems that degrade the result without failing it. */
  log?: (message: string) => void;
}

/**
 * One content type's calendar, widened backwards to cover the grace window.
 *
 * The rolling file only reaches about two days into the past, so a longer grace
 * window needs the monthly archives. Archives are merged first and the rolling
 * file last, so the freshest data wins on any overlap.
 */
/**
 * A fetched calendar and how fresh it is.
 *
 * The freshness stays beside the payload rather than on it: `stale` is a fact
 * about this fetch, not about anything SIMKL sent, and simkl/types.ts holds
 * only the shapes SIMKL actually returns.
 */
export interface CalendarResult {
  data: CalendarFile;
  stale: boolean;
}

export const fetchCalendar = async (
  type: CalendarType,
  { graceDays = config.graceDays, signal, now = new Date(), log }: CalendarOptions = {},
): Promise<CalendarResult> => {
  if (!CALENDAR_FILES[type]) throw new Error(`Unknown calendar type: ${type}`);

  const months = graceDays > ROLLING_PAST_DAYS ? monthsBack(graceDays, now) : [];

  // Concurrent: these are unauthenticated, CDN-cached files with no dependency
  // between them, and they were only sequential by accident. At the 90-day
  // ceiling that was five serial multi-MB round trips per calendar type.
  // (The warning against parallelising applies to the authenticated sync
  // endpoints in sources/library.ts, which stay serial.)
  const archives = await Promise.all(
    months.map(async ({ year, month }) => {
      try {
        return (await fetchArchive(type, year, month, { signal })).data;
      } catch (err) {
        // A missing archive just narrows the window; the rolling file still
        // works. Logged because silently serving a shorter grace window looks
        // identical to a correct feed with nothing to show.
        log?.(`archive ${year}/${month} ${type} unavailable, grace window narrowed: ${errorMessage(err)}`);
        return null;
      }
    }),
  );

  // Only the rolling file's freshness is worth reporting. A closed month's
  // archive never changes, so serving it from cache is not staleness.
  const rolling = await fetchRolling(type, { signal });
  // Archives first, rolling last, so the freshest data wins on any overlap —
  // Promise.all preserves input order, so that precedence is unchanged.
  const parts: Array<CalendarFile | null> = [...archives, rolling.data];

  // Every key still in play, so the eviction below keeps what this call needs.
  evictOutside([rollingKey(type), ...months.map((m) => archiveKey(type, m.year, m.month))], type);

  return { data: mergeCalendars(parts), stale: rolling.stale };
};

/**
 * Drop cached files this type no longer reads.
 *
 * The cache is keyed per archive month, so without this every month the process
 * survives permanently retains two more multi-MB parsed calendars it will never
 * request again — measured at roughly 4 MB apiece.
 */
const evictOutside = (keep: string[], type: CalendarType): void => {
  const wanted = new Set(keep);
  for (const key of cache.keys()) {
    if (key.startsWith(`calendar-${type}`) && !wanted.has(key)) cache.delete(key);
  }
};

export type Calendars = Record<CalendarType, CalendarResult>;

/** All calendar types. Safe to parallelise: CDN-cached, unauthenticated. */
export const fetchAllCalendars = async ({ graceDays = config.graceDays, signal, now, log }: CalendarOptions = {}): Promise<Calendars> => {
  const types = Object.keys(CALENDAR_FILES) as CalendarType[];
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { graceDays, signal, now, log })));
  // Zipped with the types that produced them, rather than each result carrying
  // its own `type` field purely so this line can read it back.
  return Object.fromEntries(types.map((t, i) => [t, results[i]!])) as Calendars;
};

/** True when any calendar was served from cache after the CDN failed. */
export const anyStale = (calendars: Calendars): boolean => Object.values(calendars).some((c) => c.stale);

/** Just the payloads, for the join — which has no use for how fresh they are. */
export const payloads = (calendars: Calendars): Record<CalendarType, CalendarFile> =>
  Object.fromEntries(Object.entries(calendars).map(([type, result]) => [type, result.data])) as Record<CalendarType, CalendarFile>;
