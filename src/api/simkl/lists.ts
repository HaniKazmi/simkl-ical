/**
 * The authenticated SIMKL list endpoints: what the poll actually calls.
 *
 * Transport only. Which lists matter, how a change is detected, and what a
 * refetch supersedes are all decisions, and they live in `src/library.ts`.
 */

import { apiGet } from './client.ts';
import type { Activities, Library, ListDefinition, ListResponse, SyncStatus, SyncType } from './types.ts';

/** Last-modified timestamps per category. Cheap gate for the expensive list fetches. */
export const getActivities = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<Activities> =>
  apiGet<Activities>('/sync/activities', { token, signal });

/**
 * The extended params are unconditional, not gated on whether the sheet sync is
 * configured. Behaviour that varies with an unrelated env var is how you get a
 * bug that only reproduces on the machine holding the credentials.
 *
 * `extended=full` keeps `ids.simkl`, so the feed join is untouched;
 * `include_all_episodes=yes` is *required* for the completed and dropped lists,
 * where `seasons[]` is otherwise absent entirely. The cost is bandwidth only —
 * 227 KB to 716 KB on a cold refresh, and zero extra requests.
 */
const fetchList = (
  token: string,
  type: SyncType,
  status: SyncStatus,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ListResponse> =>
  apiGet<ListResponse>(`/sync/all-items/${type}/${status}`, {
    token,
    params: { extended: 'full', episode_watched_at: 'yes', include_all_episodes: 'yes' },
    signal,
  });

/**
 * Sequential on purpose: the SIMKL docs warn against parallelising uncached
 * sync endpoints, and a handful of serial requests take well under a second.
 */
export const fetchLists = async (
  token: string,
  lists: ListDefinition[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<Library> => {
  const out: Library = {};
  for (const { key, type, status } of lists) {
    out[key] = await fetchList(token, type, status, { signal });
  }
  return out;
};
