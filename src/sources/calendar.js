import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const CDN_BASE = 'https://data.simkl.in/calendar/v2/';

/**
 * Calendar file per content type. Anime is a separate type in SIMKL, not a show genre.
 *
 * movie_release.json is deliberately absent: it only covers a rolling 33-day
 * window and carries a date-only 04:00Z placeholder, so films are resolved
 * per-title through /movies/{id} instead — see sources/movies.js.
 */
export const CALENDAR_FILES = {
  tv: 'tv.json',
  anime: 'anime.json',
};

/** The rolling file spans roughly -2/+34 days; beyond that we need archives. */
const ROLLING_PAST_DAYS = 2;

/** Archives run to several MB, so this is generous rather than tight. */
const FETCH_TIMEOUT_MS = 60_000;

const cachePath = (key) => join(config.dataDir, 'cache', `${key}.json`);

async function readCache(key) {
  try {
    return JSON.parse(await readFile(cachePath(key), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(key, entry) {
  await mkdir(join(config.dataDir, 'cache'), { recursive: true });
  await writeFile(cachePath(key), JSON.stringify(entry));
}

/**
 * Fetch a calendar JSON file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings, so cache-busting is impossible and a conditional
 * GET against the stored Last-Modified is the only way to tell whether a
 * regeneration has actually happened.
 */
async function fetchCached(url, key, { signal } = {}) {
  const cached = await readCache(key);
  const headers = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default.
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const fallback = () =>
    cached ? { data: cached.data, lastModified: cached.lastModified, fromCache: true } : null;

  if (res.status === 304 && cached) return fallback();
  if (!res.ok) {
    // A stale calendar beats no calendar. Only fail if there is nothing to fall back to.
    return fallback() ?? Promise.reject(new Error(`Calendar ${url} returned ${res.status}`));
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    // A 200 carrying an HTML interstitial would otherwise discard a good cache.
    const stale = fallback();
    if (stale) return stale;
    throw new Error(`Calendar ${url} returned unparseable JSON: ${err.message}`);
  }

  const lastModified = res.headers.get('last-modified');
  await writeCache(key, { lastModified, data, cachedAt: new Date().toISOString() });

  return { data, lastModified, fromCache: false };
}

export function rollingUrl(type) {
  return CDN_BASE + CALENDAR_FILES[type];
}

/**
 * Monthly archive URL.
 *
 * The month is NOT zero-padded: /2026/8/tv.json returns 200 while /2026/08/tv.json
 * returns 404. This is the one trap in the archive API.
 */
export function archiveUrl(type, year, month) {
  return `${CDN_BASE}${year}/${month}/${CALENDAR_FILES[type]}`;
}

export function fetchRolling(type, { signal } = {}) {
  return fetchCached(rollingUrl(type), `calendar-${type}`, { signal });
}

export function fetchArchive(type, year, month, { signal } = {}) {
  return fetchCached(archiveUrl(type, year, month), `calendar-${type}-${year}-${month}`, { signal });
}

/** Distinct {year, month} pairs spanned by the last `days` days, oldest first. */
export function monthsBack(days, now = new Date()) {
  const months = new Map();
  for (let i = days; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    // Unpadded month, matching the archive URL scheme.
    months.set(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`, {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
    });
  }
  return [...months.values()];
}

/** Merge calendar files, later sources winning on conflict. */
export function mergeCalendars(parts) {
  const entries = new Map();
  const metadata = {};

  for (const part of parts) {
    for (const entry of part?.calendar ?? []) {
      entries.set(`${entry.simkl_id}-${entry.episode?.season}-${entry.episode?.episode}`, entry);
    }
    Object.assign(metadata, part?.metadata ?? {});
  }

  return { calendar: [...entries.values()], metadata };
}

/**
 * One content type's calendar, widened backwards to cover the grace window.
 *
 * The rolling file only reaches about two days into the past, so a longer grace
 * window needs the monthly archives. Archives are merged first and the rolling
 * file last, so the freshest data wins on any overlap.
 */
export async function fetchCalendar(type, { graceDays = config.graceDays, signal, now = new Date() } = {}) {
  if (!CALENDAR_FILES[type]) throw new Error(`Unknown calendar type: ${type}`);

  const parts = [];
  let anyFromCache = true;

  if (graceDays > ROLLING_PAST_DAYS) {
    for (const { year, month } of monthsBack(graceDays, now)) {
      try {
        const archive = await fetchArchive(type, year, month, { signal });
        parts.push(archive.data);
        anyFromCache = anyFromCache && archive.fromCache;
      } catch {
        // A missing archive just narrows the window; the rolling file still works.
      }
    }
  }

  const rolling = await fetchRolling(type, { signal });
  parts.push(rolling.data);

  return {
    ...mergeCalendars(parts),
    type,
    lastModified: rolling.lastModified,
    fromCache: anyFromCache && rolling.fromCache,
  };
}

/** All calendar types. Safe to parallelise: CDN-cached, unauthenticated. */
export async function fetchAllCalendars({ graceDays = config.graceDays, signal, now } = {}) {
  const types = Object.keys(CALENDAR_FILES);
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { graceDays, signal, now })));
  return Object.fromEntries(results.map((r) => [r.type, r]));
}
