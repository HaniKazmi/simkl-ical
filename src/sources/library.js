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

const CATEGORIES = ['tv_shows', 'anime', 'movies'];

/**
 * The only activity timestamps that can change what appears in the feed — all
 * of them move an item between lists. `movies` carries no `watching` or `hold`
 * key, which is why absences are tolerated rather than assumed.
 */
export const MEMBERSHIP_FIELDS = ['watching', 'plantowatch', 'completed', 'hold', 'dropped', 'removed_from_list'];

/**
 * Change key for the refresh gate.
 *
 * Deliberately narrower than the whole activities payload: `playback` moves
 * every time a scrobbler reports progress and `rated_at` moves when you rate
 * something, but neither changes the feed by a single byte. Including them
 * meant a full 16-call refetch that produced an identical render. `all` is
 * excluded for the same reason — it is a roll-up that moves when they do.
 *
 * Built from an explicit field list rather than JSON.stringify, so the result
 * cannot shift if the API returns its keys in a different order.
 */
export function membershipSignature(activities) {
  const parts = [];
  for (const category of CATEGORIES) {
    const source = activities?.[category] ?? {};
    for (const field of MEMBERSHIP_FIELDS) {
      parts.push(`${category}.${field}=${source[field] ?? ''}`);
    }
  }
  return parts.join('|');
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
