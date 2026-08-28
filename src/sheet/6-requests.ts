/**
 * BUILD — a checked plan becomes one ordered batch of requests. Pure.
 *
 * Fifth of READ → PARSE → PLAN → GUARD → **BUILD** → APPLY → VERIFY, and the
 * one number that is approximate: `toRequests` builds the write, while
 * `deleteRowRequests` and `restoreRequest` build the rollback that runs after
 * VERIFY. Both are request construction, so they belong together.
 *
 * `toRequests` is the highest-value function in the subsystem. batchUpdate
 * applies requests in array order, so that order is the difference between a
 * correct write and a one-row misalignment.
 */

import type { Grid } from './2-grid.ts';
import type { SheetPlan } from './4-plan.ts';
import type { ExtendedValue, GridRange, SheetRequest } from '../api/google/types.ts';

const oneCell = (sheetId: number, row: number, column: number): GridRange => ({
  sheetId,
  startRowIndex: row,
  endRowIndex: row + 1,
  startColumnIndex: column,
  endColumnIndex: column + 1,
});

/** `fields: 'userEnteredValue'` so number formats and conditional formatting survive. */
const writeCell = (sheetId: number, row: number, column: number, value: ExtendedValue | undefined): SheetRequest => ({
  updateCells: {
    range: oneCell(sheetId, row, column),
    // An absent value clears the cell, which is what a rollback of an inserted
    // value needs.
    rows: [{ values: [value === undefined ? {} : { userEnteredValue: value }] }],
    fields: 'userEnteredValue',
  },
});

/**
 * The plan as one ordered batch, in three groups:
 *
 *   a. edits to pre-existing rows, descending by row
 *   b. the insertDimension
 *   c. the new row's fill
 *
 * The fill shares a row index with the insert. Any rule of the form "edits
 * before inserts" therefore applies the fill to whatever currently sits at that
 * index and *then* inserts a blank row below it — overwriting a real row, which
 * is the exact failure this design exists to prevent.
 */
export const toRequests = (plan: SheetPlan, grid: Grid): SheetRequest[] => {
  const { sheetId } = grid.snapshot;
  const requests: SheetRequest[] = [];

  for (const cell of [...plan.edits].sort((a, b) => b.row - a.row || b.column - a.column)) {
    requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
  }
  for (const insert of plan.inserts) {
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: insert.row, endIndex: insert.row + 1 },
        inheritFromBefore: true,
      },
    });
    for (const cell of insert.fill) requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
  }
  return requests;
};

/**
 * Prefix for the snapshot tabs the sync makes before writing. Strict, because
 * it is the sole basis on which a tab is later swept.
 */

/**
 * Where a snapshot is moved to when the run it belongs to freezes: out of the
 * swept namespace, and into a name that says what it is to whoever opens the
 * spreadsheet next.
 *
 * `frozen` is process state, so a restart forgets that a run told the user to
 * repair from a particular tab. Without the rename the next clean write would
 * sweep it away — and it is the only thing that makes the repair a copy rather
 * than an archaeology exercise in version history.
 */




/** `fields: 'title'` so the tab keeps its position, colour and grid size. */
export const renameSheetRequest = (sheetId: number, title: string): SheetRequest => ({
  updateSheetProperties: { properties: { sheetId, title }, fields: 'title' },
});

/**
 * Snapshot the tab, as the first request of the write batch.
 *
 * First, and in the *same* batch, deliberately: batchUpdate applies in order
 * and atomically, so the copy captures the pre-write state and there is no
 * window in which the write landed but the snapshot did not. It duplicates
 * server-side, so a 1644-row tab costs no data transfer.
 */
export const backupRequest = (sheetId: number, name: string): SheetRequest => ({
  duplicateSheet: { sourceSheetId: sheetId, newSheetName: name },
});

export const deleteSheetRequest = (sheetId: number): SheetRequest => ({ deleteSheet: { sheetId } });

/**
 * Put the whole tab back from its snapshot, in one server-side request.
 *
 * Source and destination sit at identical coordinates, so the paste offset is
 * zero and no relative formula reference is adjusted — which is exactly what
 * makes this immune to the off-by-one that a cell-by-cell restore invites.
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
 * Descending, so no index shifts under the deletes. There is no cell-restore
 * counterpart — `SheetSync` restores from the snapshot tab instead, because
 * putting individual cells back cannot be made safe alongside a delete: the
 * delete rewrites the relative references in everything it shifts, including
 * text written moments earlier in the same batch.
 */
export const deleteRowRequests = (sheetId: number, rows: number[]): SheetRequest[] =>
  [...rows]
    .sort((a, b) => b - a)
    .map((row) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS' as const, startIndex: row, endIndex: row + 1 } } }));
