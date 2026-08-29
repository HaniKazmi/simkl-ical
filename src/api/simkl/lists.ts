/**
 * The authenticated SIMKL sync endpoints: what the poll calls.
 *
 * Transport only. What counts as a change, what a delta means, and when
 * removals are reconciled are decisions, and they live in `src/library.ts`.
 */

import { apiGet } from './client.ts';
import type { Activities, AllItemsResponse } from './types.ts';

/** Last-modified timestamps per category. Cheap gate for the expensive pull. */
export const getActivities = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<Activities> =>
  apiGet<Activities>('/sync/activities', { component: 'poll', token, signal });

/**
 * `extended=full` is the gatekeeper: it alone turns on `seasons[]`, and the
 * other two are verified no-ops without it. `include_all_episodes=yes` is then
 * required — with `extended=full` alone, completed and dropped titles come
 * back `seasons=0`. `episode_watched_at=yes` adds the per-episode timestamp
 * the sheet plans against.
 *
 * `ids.simkl` is present regardless, so none of this carries the feed's join.
 *
 * Unconditional, not gated on whether the sheet sync is configured: behaviour
 * varying with an unrelated env var gives a bug that only reproduces on the
 * machine holding the credentials.
 */
const EXTENDED = { extended: 'full', episode_watched_at: 'yes', include_all_episodes: 'yes' };

/**
 * The library, whole or as a delta.
 *
 * With `dateFrom`, only the items that changed — as complete records, not
 * patches, so a changed show carries its full `seasons[]` and a merge is a
 * plain upsert. Without it, the entire library in one request.
 *
 * `dateFrom` is compared as an instant, strictly greater, at one-second
 * granularity: passing back the exact `activities.all` returns nothing; one
 * second earlier returns the change.
 *
 * Never call the `/{type}/{status}` form without checking the status string.
 * An unrecognised segment does not 404 — it returns every item of that type,
 * so a typo is a full-library download, not an error.
 */
export const fetchAllItems = (
  token: string,
  { dateFrom, signal }: { dateFrom?: string | null; signal?: AbortSignal } = {},
): Promise<AllItemsResponse> =>
  apiGet<AllItemsResponse>('/sync/all-items', {
    component: 'poll',
    token,
    params: dateFrom ? { ...EXTENDED, date_from: dateFrom } : EXTENDED,
    signal,
  });

/**
 * Every id currently on any list — no status, no titles.
 *
 * The only way to learn about removals: a delta never reports them, so
 * `removed_from_list` moving says one happened but not what went. Intersecting
 * what we hold with this answers it.
 *
 * 47 KB for a 741-item library. `extended=ids_only` is 152 KB and adds
 * external ids nothing here reads.
 */
export const fetchMembership = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<AllItemsResponse> =>
  apiGet<AllItemsResponse>('/sync/all-items', { component: 'poll', token, params: { extended: 'simkl_ids_only' }, signal });
