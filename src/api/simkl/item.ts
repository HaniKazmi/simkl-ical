/**
 * Reading the two fields of a library item that everything downstream keys on.
 *
 * One copy, because three modules ask: the join builds its id sets from them,
 * `library.ts` uses them to decide which list membership a refetch has
 * superseded, and the sheet's progress index does both.
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
 * The item's own status, folded for comparison against a `ListDefinition`.
 *
 * This is the field that says which list an item currently belongs to. The list
 * it arrived in does not: a move is reported only against the destination, so
 * the source keeps its copy until something else evicts it.
 */
export const itemStatus = (item: LibraryItem | null | undefined): string | null =>
  item?.status?.trim().toLowerCase() ?? null;
