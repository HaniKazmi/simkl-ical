/**
 * Which SIMKL lists this service reads, and how it decides they moved.
 *
 * The library is the one input both halves consume — the feed joins it against
 * the airdate calendars, the sheet sync derives every write from it — but only
 * the orchestrator owns it, so this sits beside the orchestrator rather than in
 * `shared/`. Pure: the calls themselves are in `api/simkl/lists.ts`.
 */

import { itemSimklId, itemStatus } from './api/simkl/item.ts';
import type { Activities, CategoryActivity, LibraryItem, ListDefinition, ListResponse, Library, SyncType } from './api/simkl/types.ts';

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
 * Drop list membership that this poll's refetch has superseded.
 *
 * A move is reported only against the destination, so the list an item left is
 * never refetched and keeps its copy indefinitely — carrying the status it held
 * at the time. Nothing in the two payloads separates that from the opposite
 * move: a stale `watching` copy saying `watching` beside a fresh `dropped` copy
 * saying `dropped` is identical, field for field, to a fresh `watching` copy
 * beside a stale `dropped` one. Any rule reading only the payloads gets one of
 * the two backwards.
 *
 * Which list was just fetched is the only thing that tells them apart, and it
 * is known here and nowhere downstream. So: an item that arrives in the list
 * its own `status` names is current there, and every other list of the same
 * type is out of date about it.
 */
export const pruneSuperseded = (library: Library, refreshed: ListDefinition[]): Library => {
  const owner = new Map<number, ListDefinition>();
  for (const list of refreshed) {
    for (const item of itemsOf(library[list.key])) {
      if (itemStatus(item) !== list.status) continue;
      const id = itemSimklId(item);
      if (id !== null) owner.set(id, list);
    }
  }
  if (!owner.size) return library;

  const pruned: Library = { ...library };
  for (const list of LISTS) {
    const superseded = (item: LibraryItem): boolean => {
      const id = itemSimklId(item);
      if (id === null) return false;
      const claimant = owner.get(id);
      return claimant !== undefined && claimant.type === list.type && claimant.key !== list.key;
    };
    const next = without(library[list.key], superseded);
    if (next) pruned[list.key] = next;
  }
  return pruned;
};

/**
 * How many items each list holds, in `LISTS` order, including the ones the
 * library has never carried — a list at zero is a fact, and dropping the key
 * would make "not fetched yet" and "empty" look the same.
 *
 * Here rather than in the status page because this module already owns which
 * lists are read and how their responses are shaped. Pure, and no new state:
 * the library is already public on the orchestrator.
 */
export const listCounts = (library: Library | null): Record<string, number> =>
  Object.fromEntries(LISTS.map((list) => [list.key, sizeOf(library?.[list.key])]));

// Summed rather than `itemsOf(...).length`, which copies every item in the
// library to read three numbers — on the status page, per request.
const sizeOf = (response: ListResponse | undefined): number =>
  (response?.shows?.length ?? 0) + (response?.anime?.length ?? 0) + (response?.movies?.length ?? 0);

const itemsOf = (response: ListResponse | undefined): LibraryItem[] => [
  ...(response?.shows ?? []),
  ...(response?.anime ?? []),
  ...(response?.movies ?? []),
];

/** A copy without the matching items, or undefined when nothing matched. */
const without = (response: ListResponse | undefined, drop: (item: LibraryItem) => boolean): ListResponse | undefined => {
  if (!response) return undefined;
  let changed = false;
  const keep = (items: LibraryItem[] | undefined): LibraryItem[] | undefined => {
    if (!items) return items;
    const kept = items.filter((item) => !drop(item));
    if (kept.length !== items.length) changed = true;
    return kept;
  };
  const next: ListResponse = { ...response, shows: keep(response.shows), anime: keep(response.anime), movies: keep(response.movies) };
  return changed ? next : undefined;
};

