import { apiGet } from '../simkl/client.js';

/**
 * The five lists that feed the calendar. Anime is a separate SIMKL type, not a
 * genre of shows, so it needs its own fetch. Movies only matter as plan-to-watch:
 * a film you have already seen has no upcoming release date worth showing.
 */
export const LISTS = [
  { key: 'shows_watching', type: 'shows', status: 'watching' },
  { key: 'shows_plantowatch', type: 'shows', status: 'plantowatch' },
  { key: 'anime_watching', type: 'anime', status: 'watching' },
  { key: 'anime_plantowatch', type: 'anime', status: 'plantowatch' },
  { key: 'movies_plantowatch', type: 'movies', status: 'plantowatch' },
];

/** Last-modified timestamps per category. Cheap gate for the expensive list fetches. */
export function getActivities(token, { signal } = {}) {
  return apiGet('/sync/activities', { token, signal });
}

export function fetchList(token, type, status, { signal } = {}) {
  return apiGet(`/sync/all-items/${type}/${status}`, { token, signal });
}

/**
 * Fetch all five lists sequentially. The SIMKL docs specifically warn against
 * parallelising uncached sync endpoints, and five serial requests take well
 * under a second.
 */
export async function fetchLibrary(token, { signal } = {}) {
  const out = {};
  for (const { key, type, status } of LISTS) {
    out[key] = await fetchList(token, type, status, { signal });
  }
  return out;
}
