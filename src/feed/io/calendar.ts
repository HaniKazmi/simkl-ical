/**
 * FETCH — airdates: the rolling file plus the monthly archives the grace
 * window reaches, merged. First of **FETCH** → JOIN → RENDER → SAVE,
 * alongside `movies.ts`.
 */

import { evictCache, fetchCached, type CdnResult, type CdnSource } from '../../api/cdn.ts';
import { config } from '../../shared/config.ts';
import { plainDateIn } from '../../shared/dates.ts';
import { errorMessage } from '../../shared/errors.ts';
import type { CalendarFile, CalendarType } from '../../api/simkl/types.ts';

const CDN_BASE = 'https://data.simkl.in/calendar/v2/';

/**
 * Calendar file per content type. Anime is a separate SIMKL type, not a show
 * genre. movie_release.json is absent: it covers only a rolling 33-day window
 * and carries a date-only 04:00Z placeholder, so films go per-title through
 * /movies/{id} — see movies.ts.
 */
export const CALENDAR_FILES: Record<CalendarType, string> = {
  tv: 'tv.json',
  anime: 'anime.json',
};

/** The rolling file spans roughly -2/+34 days; beyond that we need archives. */
const ROLLING_PAST_DAYS = 2;

/**
 * Why the payload is unusable, or null. Parseable is not usable: a 200
 * carrying `{}` or an error object would replace a good cache entry and
 * render a near-empty feed.
 */
const usable = (data: unknown): string | null =>
  Array.isArray((data as CalendarFile | undefined)?.calendar) ? null : 'returned JSON with no calendar array';

const fetchFile = (url: string, key: string, signal?: AbortSignal): Promise<CdnResult<CalendarFile>> =>
  fetchCached<CalendarFile>(url, key, { component: 'calendars', validate: usable, signal });

export const rollingUrl = (type: CalendarType): string => CDN_BASE + CALENDAR_FILES[type];

/**
 * Monthly archive URL. The month is NOT zero-padded: /2026/8/tv.json is a
 * 200, /2026/08/tv.json a 404 — the one trap in the archive API.
 */
export const archiveUrl = (type: CalendarType, year: number, month: number): string =>
  `${CDN_BASE}${year}/${month}/${CALENDAR_FILES[type]}`;

const rollingKey = (type: CalendarType): string => `calendar-${type}`;
const archiveKey = (type: CalendarType, year: number, month: number): string => `calendar-${type}-${year}-${month}`;

export const fetchRolling = (type: CalendarType, { signal }: { signal?: AbortSignal } = {}): Promise<CdnResult<CalendarFile>> =>
  fetchFile(rollingUrl(type), rollingKey(type), signal);

const fetchArchive = (
  type: CalendarType,
  year: number,
  month: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<CdnResult<CalendarFile>> => fetchFile(archiveUrl(type, year, month), archiveKey(type, year, month), signal);

export interface YearMonth {
  year: number;
  month: number;
}

/**
 * Distinct {year, month} pairs spanned by the last `days` days, oldest first.
 *
 * Counted from the **local** date: the join's cutoff is the local date minus
 * `graceDays`, and the two must agree about which months the window reaches.
 * Counting in UTC loses up to a day of grace in a behind-UTC zone near a
 * month boundary: at 2026-03-15T02:00Z in America/New_York the local cutoff
 * is 2026-02-28, but a UTC window spans March alone — an entry dated
 * 2026-02-28T23:00Z passes the join's filter while living in a February
 * archive nothing fetched.
 */
export const monthsBack = (days: number, now: Temporal.Instant = Temporal.Now.instant(), timezone: string = config.timezone): YearMonth[] => {
  const today = plainDateIn(now, timezone);
  const months = new Map<string, YearMonth>();
  for (let i = days; i >= 0; i -= 1) {
    // Plain calendar arithmetic: the zone was applied above, and applying it
    // twice invites an off-by-one. `PlainDate.month` is 1-based and unpadded,
    // matching the archive URL scheme — a padded month is a 404.
    const d = today.subtract({ days: i });
    months.set(`${d.year}-${d.month}`, { year: d.year, month: d.month });
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
  now?: Temporal.Instant;
  /** Optional sink for problems that degrade the result without failing it. */
  log?: (message: string) => void;
}

/**
 * A fetched calendar and how fresh it is. Freshness sits beside the payload:
 * this is the merged shape, which no single SIMKL response has.
 */
export interface CalendarResult {
  data: CalendarFile;
  /**
   * Read from the rolling file alone: a closed month's archive answers from
   * cache by design, so folding archives in would report an outage on a poll
   * where the rolling file was fine.
   */
  source: CdnSource;
}

/**
 * One content type's calendar, widened backwards to cover the grace window.
 * The rolling file reaches only ~2 days into the past, so a longer window
 * needs the monthly archives. The rolling file merges last, so the freshest
 * data wins on overlap.
 */
export const fetchCalendar = async (
  type: CalendarType,
  { graceDays = config.graceDays, timezone = config.timezone, signal, now = Temporal.Now.instant(), log }: CalendarOptions = {},
): Promise<CalendarResult> => {
  if (!CALENDAR_FILES[type]) throw new Error(`Unknown calendar type: ${type}`);

  const months = graceDays > ROLLING_PAST_DAYS ? monthsBack(graceDays, now, timezone) : [];

  // Safe to parallelise: unauthenticated and CDN-cached. SIMKL's warning
  // covers the authenticated sync endpoints, not these.
  const archives = await Promise.all(
    months.map(async ({ year, month }) => {
      try {
        return (await fetchArchive(type, year, month, { signal })).data;
      } catch (err) {
        // A missing archive only narrows the window. Logged because a narrowed
        // window looks identical to a feed with nothing old to show.
        log?.(`archive ${year}/${month} ${type} unavailable, grace window narrowed: ${errorMessage(err)}`);
        return null;
      }
    }),
  );

  // Only the rolling file's freshness matters: a closed month's archive never
  // changes, so a cached one is not stale.
  const rolling = await fetchRolling(type, { signal });
  // Rolling last so it wins on overlap; Promise.all preserves input order.
  const parts: Array<CalendarFile | null> = [...archives, rolling.data];

  // Drop cached files outside the window: each retained month costs ~4 MB for
  // the life of the process. Scoped to this type's keys — the other type's
  // window is not ours to prune.
  const wanted = new Set([rollingKey(type), ...months.map((m) => archiveKey(type, m.year, m.month))]);
  evictCache((key) => !key.startsWith(`calendar-${type}`) || wanted.has(key));

  return { data: mergeCalendars(parts), source: rolling.source };
};

export type Calendars = Record<CalendarType, CalendarResult>;

/** All calendar types. Safe to parallelise: CDN-cached, unauthenticated. */
export const fetchAllCalendars = async ({ graceDays = config.graceDays, timezone = config.timezone, signal, now, log }: CalendarOptions = {}): Promise<Calendars> => {
  const types = Object.keys(CALENDAR_FILES) as CalendarType[];
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { graceDays, timezone, signal, now, log })));
  return Object.fromEntries(types.map((t, i) => [t, results[i]!])) as Calendars;
};

/** True when any calendar was served from cache after the CDN failed. */
export const anyStale = (calendars: Calendars): boolean => Object.values(calendars).some((c) => c.source === 'cache');

/**
 * True when the CDN sent new bytes for any type. A 304 on every file means
 * the poll changed nothing — the normal, healthy outcome, worth saying rather
 * than inferring.
 */
export const anyChanged = (calendars: Calendars): boolean => Object.values(calendars).some((c) => c.source === 'fresh');

/** Just the payloads, for the join, which has no use for freshness. */
export const payloads = (calendars: Calendars): Record<CalendarType, CalendarFile> =>
  Object.fromEntries(Object.entries(calendars).map(([type, result]) => [type, result.data])) as Record<CalendarType, CalendarFile>;
