/**
 * The two fields of a library item everything downstream keys on.
 *
 * One copy, three askers: `library.ts` keys the library on the id, the join
 * builds its id sets from both, and the sheet's progress index reads the
 * status off every title it plans against.
 */

import type { LibraryItem } from './types.ts';

/**
 * The library nests the id under `ids.simkl`; the calendar calls it `simkl_id`.
 * Bridging the two names is the whole join.
 */
export const itemSimklId = (item: LibraryItem | null | undefined): number | null => {
  const ids = item?.show?.ids ?? item?.movie?.ids;
  const id = ids?.simkl ?? ids?.simkl_id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * The item's status, folded for comparison against a status constant.
 *
 * The only membership there is: the library holds one record per id, so this
 * field is what the item is. Optional on the wire, and a record carrying none
 * is still a title we hold — so the feed's airing rule is negative and only
 * its film rule is positive.
 */
export const itemStatus = (item: LibraryItem | null | undefined): string | null =>
  item?.status?.trim().toLowerCase() ?? null;
