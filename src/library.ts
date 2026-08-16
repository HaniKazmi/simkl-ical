/**
 * How the library is gated, merged and read.
 *
 * The library is the one input both halves consume — the feed joins it against
 * the airdate calendars, the sheet sync derives every write from it — but only
 * the orchestrator owns it, so this sits beside the orchestrator rather than in
 * `shared/`. Pure: the calls themselves are in `api/simkl/lists.ts`.
 *
 * One record per SIMKL id, keyed by id. A delta returns each changed item once
 * carrying its current `status`, so a move is a replacement and no second copy
 * of a title can survive to disagree with the first.
 */

import { itemSimklId, itemStatus } from './api/simkl/item.ts';
import type { Activities, AllItemsResponse, CategoryActivity, LibraryItem, SyncType } from './api/simkl/types.ts';

/**
 * One library record, and the type it belongs to.
 *
 * `type` is the only thing not derivable from the item: an anime record is a
 * show record with an extra `anime_type` field, and both nest their title under
 * `show`. Which top-level key of the response it arrived under is the answer,
 * and it is needed downstream — the feed picks a calendar with it, the sheet
 * skips films with it.
 *
 * `status` is deliberately *not* copied up here. `itemStatus` reads it from the
 * item, and a second copy is one that can disagree with the payload it was
 * built from — the class of bug this whole model exists to remove.
 */
export interface LibraryEntry {
  type: SyncType;
  item: LibraryItem;
}

/**
 * The user's library: one authoritative record per SIMKL id.
 *
 * A delta returns each changed item once, carrying its current `status`, so an
 * item cannot be present twice and cannot disagree with itself. List membership
 * is not a thing this model can represent, which is the point.
 */
export type Library = Map<number, LibraryEntry>;


/** The activities payload names the show category `tv_shows`; the sync path uses `shows`. */
const ACTIVITY_CATEGORY: Record<SyncType, keyof Activities> = {
  shows: 'tv_shows',
  anime: 'anime',
  movies: 'movies',
};

const TYPES: SyncType[] = ['shows', 'anime', 'movies'];

/** The statuses an item can hold. `movies` carries no `watching` or `hold`. */
const STATUSES = ['watching', 'plantowatch', 'completed', 'hold', 'dropped'] as const;

/** The named timestamps of every category, joined into one comparable string. */
const signature = (activities: Activities | null | undefined, fields: readonly (keyof CategoryActivity)[]): string =>
  TYPES.map((type) => {
    const source = (activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity;
    return `${type}:${fields.map((field) => source[field] ?? '').join(',')}`;
  }).join('|');

/**
 * Whether anything worth a pull moved.
 *
 * Deliberately not `activities.all`, which rolls up `playback` and `rated_at`
 * as well: a scrobbler reporting progress bumps `playback` continuously, and
 * gating on the roll-up would pull a delta on every single poll to find nothing
 * that changes a feed or a sheet. `all` is still what gets *sent* as
 * `date_from` — the trigger and the watermark are different questions.
 */
export const librarySignature = (activities: Activities | null | undefined): string => signature(activities, STATUSES);

/**
 * When each category last had something removed from it.
 *
 * Tracked per category rather than as one string because a removal moves this
 * and nothing else — the item simply stops existing, so no status timestamp
 * advances and no delta record is ever produced for it — and because *which*
 * category moved is what makes a truncated membership response detectable.
 */
export const removalStamps = (activities: Activities | null | undefined): Record<SyncType, string> =>
  Object.fromEntries(
    TYPES.map((type) => {
      const source = (activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity;
      return [type, source.removed_from_list ?? ''];
    }),
  ) as Record<SyncType, string>;

/** The categories whose removal stamp has moved since the ones held. */
export const movedRemovals = (
  previous: Record<SyncType, string>,
  current: Record<SyncType, string>,
): Set<SyncType> => new Set(TYPES.filter((type) => previous[type] !== current[type]));

/**
 * The watermark, backed off by a second, which is what `date_from` should ask
 * for.
 *
 * `date_from` is compared strictly greater, at one-second granularity: passing
 * back the exact `activities.all` returns nothing at all, and one second
 * earlier returns the newest change. So a write landing in the same second as
 * the `activities.all` this poll read, but committed just after it, would never
 * be asked for again — the next poll's watermark is already past it. Overlapping
 * by a second closes that, and costs one re-sent record into an idempotent
 * merge.
 *
 * Returns the input unchanged if it is not a parseable instant: sending back
 * what SIMKL gave us is always safer than sending a guess.
 */
export const deltaFrom = (watermark: string | null | undefined): string | null => {
  if (!watermark) return null;
  const at = Date.parse(watermark);
  return Number.isNaN(at) ? watermark : new Date(at - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/** Each item in the response, tagged with the type key it arrived under. */
const entriesOf = function* (response: AllItemsResponse | null | undefined): Generator<[number, SyncType, LibraryItem]> {
  for (const type of TYPES) {
    for (const item of response?.[type] ?? []) {
      const id = itemSimklId(item);
      // An item with no usable id is dropped here, at the one point it enters
      // the model. Everything downstream keys on the id and can assume one.
      if (id !== null) yield [id, type, item];
    }
  }
};

/** A full pull becomes the library outright — the same upsert, starting from nothing. */
export const toLibrary = (response: AllItemsResponse | null | undefined): Library =>
  mergeDelta(new Map(), response).library;

/**
 * A delta folded into what we already hold.
 *
 * A plain upsert by id, and nothing else: delta records are complete item
 * records rather than partial patches — a changed show carries its full
 * `seasons[]` with every watched episode — so there is no field-level merging
 * to do, and re-merging the same record is a no-op. That idempotence is load
 * bearing, because the poll asks for one second more than it strictly needs and
 * so re-receives the newest records by design.
 *
 * Type-blind and status-blind on purpose. Filtering here — dropping films that
 * come back `completed`, say — would skip the very record that says a film left
 * plan-to-watch, leaving the stale `plantowatch` copy in place and the film in
 * the feed for good. The consumers filter; the merge only records what SIMKL
 * said.
 *
 * Returns a new Map rather than mutating, so the orchestrator swaps the library
 * in one assignment and a render holding the old one renders a coherent
 * library rather than a half-merged one.
 *
 * `updated` counts every record the delta carried; `reshaped` counts only those
 * that arrived new or under a different `status`. The two differ on the most
 * common event there is — watching an episode rewrites a record without moving
 * it — and the gap is what tells a consumer that reads membership from one that
 * reads progress. Which of the two matters is the consumer's business, so this
 * reports both and decides neither.
 */
export const mergeDelta = (
  previous: Library,
  response: AllItemsResponse | null | undefined,
): { library: Library; updated: number; reshaped: number } => {
  const library: Library = new Map(previous);
  let updated = 0;
  let reshaped = 0;
  for (const [id, type, item] of entriesOf(response)) {
    const before = previous.get(id);
    if (!before || before.type !== type || itemStatus(before.item) !== itemStatus(item)) reshaped += 1;
    library.set(id, { type, item });
    updated += 1;
  }
  return { library, updated, reshaped };
};

/** The ids in a membership response — the whole of what `simkl_ids_only` says. */
export const membershipIds = (response: AllItemsResponse | null | undefined): Set<number> => {
  const ids = new Set<number>();
  for (const [id] of entriesOf(response)) ids.add(id);
  return ids;
};

/**
 * Drop everything the membership set no longer names, within the categories
 * that actually reported a removal.
 *
 * `within` is the discriminator, and it is the only one available. A category
 * holding nothing is *omitted* from the response rather than sent empty, so a
 * truncated payload and a category the user emptied are the same bytes. What
 * separates them is `removed_from_list`: emptying a category moves that
 * category's stamp, and a truncated response does not move anything. So a
 * category nobody reported a removal for is left alone entirely, however many
 * of its ids the response failed to mention.
 *
 * Within a category that did report one, dropping more than half of what is
 * held is still refused — the stamp says *something* went, not that everything
 * did, and applying a partial payload there empties the feed of that type.
 * Refusing costs a stale removal the next poll retries.
 *
 * The refusal lives here, in the only function that deletes, so no caller can
 * reach the delete without it. Reporting `applied` rather than acting on it
 * keeps what happens next — the log line, the withheld stamp — in the shell.
 *
 * The same Map comes back when nothing goes, so a poll that reconciled and
 * found nothing removed does not churn the library or force a re-render.
 */
export const retainOnly = (
  library: Library,
  keep: Set<number>,
  within: Set<SyncType>,
): { library: Library; removed: number; applied: boolean } => {
  const gone: number[] = [];
  const held = new Map<SyncType, number>();
  const going = new Map<SyncType, number>();
  for (const [id, entry] of library) {
    if (!within.has(entry.type)) continue;
    held.set(entry.type, (held.get(entry.type) ?? 0) + 1);
    if (keep.has(id)) continue;
    going.set(entry.type, (going.get(entry.type) ?? 0) + 1);
    gone.push(id);
  }

  for (const [type, count] of held) {
    if ((going.get(type) ?? 0) > count / 2) return { library, removed: 0, applied: false };
  }
  if (!gone.length) return { library, removed: 0, applied: true };

  const next: Library = new Map(library);
  for (const id of gone) next.delete(id);
  return { library: next, removed: gone.length, applied: true };
};

/** A film is never `watching` or on `hold` — SIMKL omits both keys for movies. */
const MOVIE_STATUSES = STATUSES.filter((status) => status !== 'watching' && status !== 'hold');

/**
 * Every type/status pair, including the ones this library has never held — a
 * count of zero is a fact, and dropping the key would make "nothing there" and
 * "never fetched" look the same.
 *
 * `other` catches a status SIMKL adds later, and the records carrying no
 * `status` at all — which exist, and are why the feed's airing rule is
 * negative. Without it the rows would not sum to the total on a real library.
 *
 * Here rather than in the status page because this module already owns how the
 * library is shaped and read. Pure, and no new state.
 */
export const COUNT_KEYS: string[] = [
  ...TYPES.flatMap((type) => (type === 'movies' ? MOVIE_STATUSES : STATUSES).map((status) => `${type}/${status}`)),
  'other',
];

/**
 * Memoised on the library's identity, which is exactly right: every change
 * replaces the Map (`toLibrary` and `mergeDelta` build a new one, `retainOnly`
 * returns the same one only when nothing went), so a hit cannot be stale. The
 * status page asks per request, and counting 700-odd records to answer a page
 * a human loaded is work the previous list-keyed shape never had to do.
 */
const countsFor = new WeakMap<Library, Record<string, number>>();

export const libraryCounts = (library: Library | null): Record<string, number> => {
  const cached = library && countsFor.get(library);
  if (cached) return cached;

  const counts: Record<string, number> = {};
  for (const key of COUNT_KEYS) counts[key] = 0;
  for (const entry of library?.values() ?? []) {
    const key = `${entry.type}/${itemStatus(entry.item) ?? ''}`;
    const bucket = Object.hasOwn(counts, key) ? key : 'other';
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }

  if (library) countsFor.set(library, counts);
  return counts;
};
