import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a1, parseGrid, type Grid, type HeaderName } from '../../src/sheet/1-grid.ts';
import { deleteRowRequests, toRequests } from '../../src/sheet/5-requests.ts';
import { dateSerial } from '../../src/sheet/2-progress.ts';
import type { CellEdit, RowInsert, SheetPlan } from '../../src/sheet/3-plan.ts';
import type { ExtendedValue } from '../../src/api/google/types.ts';
import { sheetSnapshot, SHEET_HEADERS, type CellSpec, seasonRow, showRow } from '../helpers.ts';
const H = SHEET_HEADERS;
const TODAY = dateSerial(new Date().toISOString().slice(0, 10));

const show = (title: string, status: string): CellSpec[] => showRow(title, status, 1);
const season = seasonRow;

//  row 0 header | 1 show | 2 season 1 (closed) | 3 season 2 (open)
const grid: Grid = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended'), season(1, 6, 44000), season(2, 3, null)]));

const cell = (row: number, field: HeaderName, value: ExtendedValue, previous?: ExtendedValue): CellEdit => ({
  row,
  column: grid.columns[field],
  field,
  previous: previous ?? grid.snapshot.rows[row]?.[grid.columns[field]]?.userEnteredValue,
  value,
  address: a1(row, grid.columns[field]),
  note: 'test',
});

const planOf = (edits: CellEdit[] = [], inserts: RowInsert[] = []): SheetPlan => ({ edits, inserts, skipped: [], notes: [], deferred: 0 });

const insertAt = (row: number, season: number, title = 'Fargo'): RowInsert => ({
  row,
  title,
  season,
  fill: (
    [
      ['Season', { numberValue: season }],
      ['Episode', { numberValue: 4 }],
      ['Start', { numberValue: TODAY - 10 }],
      ['Episodes', { numberValue: 0.0153 }],
      ['Length', { formulaValue: `=G${row + 1}*D${row + 1}` }],
    ] as Array<[HeaderName, ExtendedValue]>
  ).map(([field, value]) => ({ row, column: grid.columns[field], field, previous: undefined, value, address: a1(row, grid.columns[field]), note: 'new' })),
  note: 'new row',
});

const kinds = (requests: ReturnType<typeof toRequests>) =>
  requests.map((r) =>
    'insertDimension' in r ? 'insert' : 'deleteDimension' in r ? 'delete' : 'updateCells' in r ? `write@${r.updateCells.range.startRowIndex}` : Object.keys(r)[0],
  );

test('every write is a single cell, with userEnteredValue fields only', () => {
  for (const request of toRequests(planOf([cell(3, 'Episode', { numberValue: 8 })], [insertAt(4, 3)]), grid)) {
    if (!('updateCells' in request)) continue;
    const { range, fields, rows } = request.updateCells;
    assert.equal((range.endRowIndex ?? 0) - (range.startRowIndex ?? 0), 1);
    assert.equal((range.endColumnIndex ?? 0) - (range.startColumnIndex ?? 0), 1);
    assert.equal(fields, 'userEnteredValue');
    assert.equal(rows[0]?.values?.length, 1);
  }
});

test('an edit below an insert is still emitted before it', () => {
  const requests = toRequests(planOf([cell(3, 'Episode', { numberValue: 8 })], [insertAt(4, 3)]), grid);
  assert.deepEqual(kinds(requests).slice(0, 2), ['write@3', 'insert']);
});

// The case a single ordering rule gets wrong. The fill shares a row index with
// the insert, so "edits before inserts" would write the fill over whatever
// currently sits there and *then* insert a blank row below it.
test('an insert precedes its own fill, which shares the same row index', () => {
  const requests = toRequests(planOf([], [insertAt(4, 3)]), grid);
  assert.equal(kinds(requests)[0], 'insert');
  assert.ok(kinds(requests).slice(1).every((k) => k === 'write@4'));
});

// deleteDimension shifts every row beneath it, so the deletes go bottom-up and
// no index moves under one that has not run yet.
test('row deletions are emitted descending', () => {
  assert.deepEqual(
    deleteRowRequests(1, [4, 40, 9]).map((r) => ('deleteDimension' in r ? r.deleteDimension.range.startIndex : -1)),
    [40, 9, 4],
  );
});
