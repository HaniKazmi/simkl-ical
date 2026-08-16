/**
 * The authenticated SIMKL sync endpoints: what the poll actually calls.
 *
 * Transport only. What counts as a change, what a delta means for what we hold,
 * and when removals have to be reconciled are all decisions, and they live in
 * `src/library.ts`.
 */

import { apiGet } from './client.ts';
import type { Activities, AllItemsResponse } from './types.ts';

/** Last-modified timestamps per category. Cheap gate for the expensive pull. */
export const getActivities = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<Activities> =>
  apiGet<Activities>('/sync/activities', { token, signal });

/**
 * `extended=full` is the gatekeeper: it alone turns on `seasons[]`, and the
 * other two are verified no-ops without it. `include_all_episodes=yes` is then
 * genuinely required — with `extended=full` alone, completed and dropped titles
 * come back `seasons=0`, so a finished show reads as a watched count with no
 * episodes behind it. `episode_watched_at=yes` adds the per-episode timestamp
 * the sheet plans against.
 *
 * `ids.simkl` is present with or without any of them, so none of this is what
 * keeps the feed's join working.
 *
 * The params are unconditional, not gated on whether the sheet sync is
 * configured. Behaviour that varies with an unrelated env var is how you get a
 * bug that only reproduces on the machine holding the credentials.
 */
const EXTENDED = { extended: 'full', episode_watched_at: 'yes', include_all_episodes: 'yes' };

/**
 * The library, whole or as a delta.
 *
 * With `dateFrom` this returns only the items that changed — as *complete*
 * records, not patches, so a changed show carries its full `seasons[]` and a
 * merge is a plain upsert. Without it, the entire library across all three
 * types in one request.
 *
 * `dateFrom` goes out exactly as `/sync/activities` gave it. It is compared as
 * an instant, strictly greater, at one-second granularity: passing back the
 * exact `activities.all` returns nothing, one second earlier returns the change.
 *
 * Never call the `/{type}/{status}` form without checking the status string.
 * An unrecognised segment does not 404 — it silently returns *every* item of
 * that type, so a typo is a full-library download rather than an error.
 */
export const fetchAllItems = (
  token: string,
  { dateFrom, signal }: { dateFrom?: string | null; signal?: AbortSignal } = {},
): Promise<AllItemsResponse> =>
  apiGet<AllItemsResponse>('/sync/all-items', {
    token,
    params: dateFrom ? { ...EXTENDED, date_from: dateFrom } : EXTENDED,
    signal,
  });

/**
 * Every id currently on any list, and nothing else — no status, no titles.
 *
 * The only way to learn about removals: a delta reports items added and
 * changed, never removed, so `removed_from_list` moving says that one happened
 * but not what went. Intersecting what we hold with this answers it.
 *
 * 47 KB for a 741-item library. `extended=ids_only` is 152 KB and adds external
 * ids nothing here reads.
 */
export const fetchMembership = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<AllItemsResponse> =>
  apiGet<AllItemsResponse>('/sync/all-items', { token, params: { extended: 'simkl_ids_only' }, signal });
