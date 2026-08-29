/**
 * The library, counted — the status page's size sanity check and the
 * per-status deltas its movement line shows.
 *
 * Beside `library.ts`, not under `status/`: counting is about how the library
 * is shaped; what the page calls the rows ("films" for `movies`) stays with
 * the page. Pure, no new state.
 */

import { itemStatus } from './api/simkl/item.ts';
import type { SyncType } from './api/simkl/types.ts';
import type { Library } from './library.ts';

const TYPES: SyncType[] = ['shows', 'anime', 'movies'];

/** The statuses an item can hold. `movies` carries no `watching` or `hold`. */
const STATUSES = ['watching', 'plantowatch', 'completed', 'hold', 'dropped'];
const MOVIE_STATUSES = STATUSES.filter((status) => status !== 'watching' && status !== 'hold');

const statusesFor = (type: SyncType): string[] => (type === 'movies' ? MOVIE_STATUSES : STATUSES);

/**
 * Every type/status pair, including ones never held — a zero is a fact, and
 * dropping the key would make "nothing there" and "never fetched" look the
 * same.
 *
 * `other` catches a status SIMKL adds later and the records carrying no
 * `status` at all — which exist, and are why the feed's airing rule is
 * negative. Without it the rows would not sum to the total.
 */
export interface LibraryCounts {
  byType: Record<SyncType, Record<string, number>>;
  other: number;
}

/**
 * Memoised on the library's identity: every change replaces the Map
 * (`retainOnly` returns the same one only when nothing went), so a hit cannot
 * be stale. The status page asks per request, and counting 700-odd records
 * per page load is work worth remembering.
 */
const countsFor = new WeakMap<Library, LibraryCounts>();

export const libraryCounts = (library: Library | null): LibraryCounts => {
  const cached = library && countsFor.get(library);
  if (cached) return cached;

  const counts: LibraryCounts = {
    byType: Object.fromEntries(TYPES.map((type) => [type, Object.fromEntries(statusesFor(type).map((status) => [status, 0]))])) as LibraryCounts['byType'],
    other: 0,
  };
  for (const entry of library?.values() ?? []) {
    const bucket = counts.byType[entry.type];
    const status = itemStatus(entry.item) ?? '';
    if (Object.hasOwn(bucket, status)) bucket[status] = (bucket[status] ?? 0) + 1;
    else counts.other += 1;
  }

  if (library) countsFor.set(library, counts);
  return counts;
};

export const totalCount = (counts: LibraryCounts): number =>
  TYPES.reduce((sum, type) => sum + Object.values(counts.byType[type]).reduce((s, n) => s + n, 0), counts.other);

/**
 * One total per type, in `TYPES` order, `other` last. A zero `other` is still
 * returned — whether it earns a row is the page's call.
 */
export const totalsByType = (counts: LibraryCounts): Array<{ type: SyncType | 'other'; count: number }> => [
  ...TYPES.map((type) => ({ type: type as SyncType | 'other', count: Object.values(counts.byType[type]).reduce((s, n) => s + n, 0) })),
  { type: 'other', count: counts.other },
];

/** One count that moved between two snapshots: `shows`/`watching` went up two. */
export interface CountDelta {
  type: SyncType | 'other';
  /** Null for the `other` bucket, which has no status to name. */
  status: string | null;
  delta: number;
}

/**
 * Which counts moved between two snapshots, and by how much, in stable
 * type-then-status order. Zeroes are left out.
 */
export const countDeltas = (before: LibraryCounts, after: LibraryCounts): CountDelta[] => {
  const deltas: CountDelta[] = [];
  for (const type of TYPES) {
    for (const status of statusesFor(type)) {
      const delta = (after.byType[type][status] ?? 0) - (before.byType[type][status] ?? 0);
      if (delta !== 0) deltas.push({ type, status, delta });
    }
  }
  const other = after.other - before.other;
  if (other !== 0) deltas.push({ type: 'other', status: null, delta: other });
  return deltas;
};
