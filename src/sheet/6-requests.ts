/**
 * BUILD — a checked plan becomes one ordered batch of requests. Pure.
 *
 * `toRequests` builds the write; `deleteRowRequests` and `restoreRequest`
 * build the rollback that runs after VERIFY. Both are request construction,
 * so they belong together.
 *
 * batchUpdate applies requests in array order, so `toRequests`'s ordering is
 * the difference between a correct write and a one-row misalignment.
 */

import type { ExtendedValue, GridRange, SheetRequest } from '../api/google/types.ts';

/**
 * What building a batch needs from a planned write, and nothing more.
 *
 * Structural rather than `CellEdit`, because the two tabs have different field
 * vocabularies and this module reads no field name — only where a value goes.
 * A `HeaderName` in the signature would force a generic through every caller
 * to say something the ordering rules below do not depend on.
 */
export interface PlannedCell {
  row: number;
  column: number;
  value: ExtendedValue | undefined;
}

export interface PlannedWrites {
  edits: readonly PlannedCell[];
  /**
   * One contiguous span of `rows` rows starting at `row`, or nothing. A span
   * rather than a row because a block is a show row and every season row under
   * it, which have to arrive together — a show row alone merges the block below
   * it into the one above, and a season row alone belongs to the wrong block.
   *
   * `groupFrom` is the offset of the first row of the span that belongs in a
   * row group under the row above it — `1` for a block, whose season rows fold
   * under its show row; `0` for a season row, which joins its block's group;
   * `null` for a tab with no outline, which the films tab is. Required rather
   * than defaulted, like `rows`: a films insert that inherited a group would
   * put an outline on a flat tab.
   */
  insert: { row: number; rows: number; fill: readonly PlannedCell[]; groupFrom: number | null } | null;
}

/**
 * Every row one span covers. One copy, because the same answer is what the
 * budget counts, what VERIFY inspects and what a rollback deletes; three
 * spellings of it would let a two-row block be budgeted as one row.
 */
export const spanRows = (insert: { row: number; rows: number }): number[] =>
  Array.from({ length: insert.rows }, (_, offset) => insert.row + offset);

/** The distinct rows a plan touches — what `SHEET_MAX_ROWS` counts. */
export const rowsTouched = (plan: PlannedWrites): number =>
  new Set([...plan.edits.map((e) => e.row), ...(plan.insert ? spanRows(plan.insert) : [])]).size;

/**
 * A plan and the grid it was planned against, tied together.
 *
 * `toRequests` addresses one tab's row and column indices at one `sheetId`,
 * and the two have to come from the same grid: a films plan sent to the show
 * grid's id is a one-row misalignment on both tabs at once, which is the
 * failure this module exists to order correctly. The brand costs one call to
 * `writesFor` at each site and makes the pairing a single, visible act.
 *
 * Structural on both sides, because this module reads no field name and
 * names no tab: the driver that calls it ties each tab's plan type to its grid
 * type, so the pairing is checked there and this stays a leaf.
 */
// A module-private symbol, so the brand cannot be forged by an object literal
// that happens to carry the right key — the same reason `2-html.ts` brands
// safe HTML this way.
const planned = Symbol('planned-against');

export interface BoundWrites extends PlannedWrites {
  readonly [planned]: number;
}

/** Bind a plan to the grid it was built from. The only way to make a `BoundWrites`. */
export const writesFor = (plan: PlannedWrites, grid: { snapshot: { sheetId: number } }): BoundWrites =>
  ({ ...plan, [planned]: grid.snapshot.sheetId }) as BoundWrites;

const oneCell = (sheetId: number, row: number, column: number): GridRange => ({
  sheetId,
  startRowIndex: row,
  endRowIndex: row + 1,
  startColumnIndex: column,
  endColumnIndex: column + 1,
});

/** `fields: 'userEnteredValue'` so number formats and conditional formatting survive. */
export const writeCell = (sheetId: number, row: number, column: number, value: ExtendedValue | undefined): SheetRequest => ({
  updateCells: {
    range: oneCell(sheetId, row, column),
    // An absent value clears the cell. The one caller that passes one is a
    // closing season row giving up its last-watched note (the artwork page's
    // link write always carries a value), and an empty `userEnteredValue` is what
    // leaves a cell a later read calls blank — an empty string would leave the
    // cell holding something.
    rows: [{ values: [value === undefined ? {} : { userEnteredValue: value }] }],
    fields: 'userEnteredValue',
  },
});

/**
 * The plan as one ordered batch, in four groups:
 *
 *   a. edits to pre-existing rows, descending by row
 *   b. the insertDimension, one request for the whole span
 *   c. the fill, at the row each cell names
 *   d. the regroup: a row group deleted over the whole span, then added over
 *      the rows from `groupFrom`
 *
 * The fill shares its row indices with the insert, so a rule of "edits before
 * inserts" would apply the fill to whatever sits at those indices and *then*
 * insert blank rows below them — overwriting real rows, the exact failure
 * this design exists to prevent.
 *
 * The regroup exists because Sheets extends a row group when rows are inserted
 * at its end, and a block goes in exactly there: before the next block's show
 * row, which is the row after the previous block's last season row. Without it
 * the whole span — the new show row included — sits inside the block above's
 * group, and the tab folds two blocks under one show row: 23 of the 23 blocks
 * the sync inserted before this step were absorbed that way. The delete needs
 * no read of the outline first: over rows no group covers it is a no-op, and
 * the span never straddles a group, because a group ends at a block boundary
 * and the span is inserted at one — so after the insert it is wholly inside
 * the extended group or wholly outside every group. Adjacent groups merge, so
 * a season row regrouped over its own row lands inside its block's group
 * wherever in the block it was inserted; under a hand block carrying no group
 * it gets a one-row group of its own, which is the outline that block would
 * have. VERIFY does not inspect groups: they are outline, not data, and a
 * verify failure there would roll back a correct write.
 */
export const toRequests = (plan: BoundWrites): SheetRequest[] => {
  const sheetId = plan[planned];
  const requests: SheetRequest[] = [];

  for (const cell of [...plan.edits].sort((a, b) => b.row - a.row || b.column - a.column)) {
    requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
  }
  if (plan.insert) {
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: plan.insert.row, endIndex: plan.insert.row + plan.insert.rows },
        inheritFromBefore: true,
      },
    });
    for (const cell of plan.insert.fill) requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
    if (plan.insert.groupFrom !== null) {
      const { row, rows, groupFrom } = plan.insert;
      requests.push({ deleteDimensionGroup: { range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + rows } } });
      requests.push({ addDimensionGroup: { range: { sheetId, dimension: 'ROWS', startIndex: row + groupFrom, endIndex: row + rows } } });
    }
  }
  return requests;
};

/** `fields: 'title'` so the tab keeps its position, colour and grid size. */
export const renameSheetRequest = (sheetId: number, title: string): SheetRequest => ({
  updateSheetProperties: { properties: { sheetId, title }, fields: 'title' },
});

/**
 * Snapshot the tab, as the first request of the write batch.
 *
 * First, and in the *same* batch: batchUpdate applies in order and
 * atomically, so the copy captures the pre-write state and there is no window
 * where the write landed but the snapshot did not. It duplicates server-side,
 * so a 1644-row tab costs no data transfer.
 */
export const backupRequest = (sheetId: number, name: string): SheetRequest => ({
  duplicateSheet: { sourceSheetId: sheetId, newSheetName: name },
});

export const deleteSheetRequest = (sheetId: number): SheetRequest => ({ deleteSheet: { sheetId } });

/**
 * Put the whole tab back from its snapshot, in one server-side request.
 *
 * Source and destination sit at identical coordinates, so the paste offset is
 * zero and no relative formula reference is adjusted — immune to the
 * off-by-one a cell-by-cell restore invites.
 *
 * The caller must delete any inserted rows first: this overwrites a range, it
 * does not shrink the grid, so an extra row would survive underneath it.
 */
export const restoreRequest = (fromSheetId: number, toSheetId: number, rowCount: number, columnCount: number): SheetRequest => ({
  copyPaste: {
    source: { sheetId: fromSheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
    destination: { sheetId: toSheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
    pasteType: 'PASTE_NORMAL',
  },
});

/**
 * Undo the structural half of a write: delete the rows it inserted.
 *
 * Descending, so no index shifts under the deletes. No cell-restore
 * counterpart — `SheetSync` restores from the snapshot tab, because putting
 * cells back cannot be made safe alongside a delete: the delete rewrites the
 * relative references in everything it shifts, including text written moments
 * earlier in the same batch.
 */
export const deleteRowRequests = (sheetId: number, rows: number[]): SheetRequest[] =>
  [...rows]
    .sort((a, b) => b - a)
    .map((row) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS' as const, startIndex: row, endIndex: row + 1 } } }));
