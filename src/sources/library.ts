import { apiGet } from '../simkl/client.ts';
import type {
  Activities,
  CategoryActivity,
  Library,
  ListDefinition,
  ListResponse,
  SyncStatus,
  SyncType,
} from '../simkl/types.ts';

/**
 * The lists that feed the calendar and the sheet sync. Anime is a separate
 * SIMKL type, not a genre of shows, so it needs its own fetch. Movies only
 * matter as plan-to-watch: a film you have already seen has no upcoming release
 * date worth showing.
 *
 * `hold` and `dropped` earn their place through the sheet sync rather than the
 * feed — `join` reads library keys by name, so nothing here can leak into it.
 * The sync needs them because "absent from every list" has to mean *no
 * information*: without them a dropped show is indistinguishable from one that
 * never existed, and neither its `Abandoned` status nor its frozen season rows
 * could be reasoned about.
 */
export const LISTS: ListDefinition[] = [
  { key: 'shows_watching', type: 'shows', status: 'watching' },
  { key: 'shows_plantowatch', type: 'shows', status: 'plantowatch' },
  // SIMKL marks an ongoing show "completed" once you have watched everything
  // aired so far, so a between-seasons show sits here rather than in watching.
  // Excluding it would silently drop the next season from the feed.
  { key: 'shows_completed', type: 'shows', status: 'completed' },
  { key: 'shows_hold', type: 'shows', status: 'hold' },
  { key: 'shows_dropped', type: 'shows', status: 'dropped' },
  { key: 'anime_watching', type: 'anime', status: 'watching' },
  { key: 'anime_plantowatch', type: 'anime', status: 'plantowatch' },
  { key: 'anime_completed', type: 'anime', status: 'completed' },
  { key: 'anime_hold', type: 'anime', status: 'hold' },
  { key: 'anime_dropped', type: 'anime', status: 'dropped' },
  { key: 'movies_plantowatch', type: 'movies', status: 'plantowatch' },
];

/** The activities payload names the show category `tv_shows`; the sync path uses `shows`. */
const ACTIVITY_CATEGORY: Record<SyncType, keyof Activities> = {
  shows: 'tv_shows',
  anime: 'anime',
  movies: 'movies',
};

/** Last-modified timestamps per category. Cheap gate for the expensive list fetches. */
export const getActivities = (token: string, { signal }: { signal?: AbortSignal } = {}): Promise<Activities> =>
  apiGet<Activities>('/sync/activities', { token, signal });

/**
 * Change key for a single list, so each can be gated individually — marking an
 * episode watched refetches only `shows/watching`.
 *
 * `removed_from_list` is folded in because a removal is reported only there,
 * never against the status the item left; being per-category, it invalidates
 * the whole category. `playback`, `rated_at` and the `all` roll-up are ignored:
 * none can change the feed.
 */
export const listSignature = (activities: Activities | null | undefined, { type, status }: Pick<ListDefinition, 'type' | 'status'>): string => {
  const source = (activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity;
  return `${status}=${source[status] ?? ''}|removed=${source.removed_from_list ?? ''}`;
};

/** Change keys for every list, keyed the same way as the library object. */
export const listSignatures = (activities: Activities | null | undefined): Record<string, string> =>
  Object.fromEntries(LISTS.map((list) => [list.key, listSignature(activities, list)]));

/**
 * Which lists have changed since the given signatures. An unknown list (no
 * stored signature) counts as stale, so a cold start fetches everything.
 */
export const staleLists = (activities: Activities | null | undefined, previous: Record<string, string> = {}): ListDefinition[] => {
  const current = listSignatures(activities);
  return LISTS.filter((list) => current[list.key] !== previous[list.key]);
};

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
