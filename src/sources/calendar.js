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

const cachePath = (type) => join(config.dataDir, 'cache', `calendar-${type}.json`);

async function readCache(type) {
  try {
    return JSON.parse(await readFile(cachePath(type), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(type, entry) {
  await mkdir(join(config.dataDir, 'cache'), { recursive: true });
  await writeFile(cachePath(type), JSON.stringify(entry));
}

/**
 * Fetch one calendar file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings entirely, so cache-busting is impossible and a
 * conditional GET against the stored Last-Modified is the only way to tell whether
 * a regeneration has actually happened. Files regenerate every 6h.
 */
export async function fetchCalendar(type, { signal } = {}) {
  const file = CALENDAR_FILES[type];
  if (!file) throw new Error(`Unknown calendar type: ${type}`);

  const cached = await readCache(type);
  const headers = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const res = await fetch(CDN_BASE + file, { headers, signal });

  if (res.status === 304 && cached) {
    return { ...cached.data, type, fromCache: true, lastModified: cached.lastModified };
  }
  if (!res.ok) {
    // A stale calendar beats no calendar. Only fail if there is nothing to fall back to.
    if (cached) return { ...cached.data, type, fromCache: true, lastModified: cached.lastModified };
    throw new Error(`Calendar ${file} returned ${res.status}`);
  }

  const data = await res.json();
  const lastModified = res.headers.get('last-modified');
  await writeCache(type, { lastModified, data, cachedAt: new Date().toISOString() });

  return { ...data, type, fromCache: false, lastModified };
}

/** All three calendar files. Safe to parallelise: CDN-cached, unauthenticated. */
export async function fetchAllCalendars({ signal } = {}) {
  const types = Object.keys(CALENDAR_FILES);
  const results = await Promise.all(types.map((t) => fetchCalendar(t, { signal })));
  return Object.fromEntries(results.map((r) => [r.type, r]));
}
