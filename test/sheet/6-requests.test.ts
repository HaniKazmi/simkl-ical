import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteRowRequests, toRequests, writesFor } from '../../src/sheet/6-requests.ts';
import { fx, planOf, TODAY } from './fixture.ts';

/** The batch as a readable shape: what each request is, and which row it hits. */
const kinds = (requests: ReturnType<typeof toRequests>) =>
  requests.map((r) =>
    'insertDimension' in r ? 'insert' : 'deleteDimension' in r ? 'delete' : 'updateCells' in r ? `write@${r.updateCells.range.startRowIndex}` : Object.keys(r)[0],
  );

test('every write is a single cell, with userEnteredValue fields only', () => {
  for (const request of toRequests(writesFor(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 })], fx.insertAt(fx.end, 3)), fx.grid))) {
    if (!('updateCells' in request)) continue;
    const { range, fields, rows } = request.updateCells;
    assert.equal((range.endRowIndex ?? 0) - (range.startRowIndex ?? 0), 1);
    assert.equal((range.endColumnIndex ?? 0) - (range.startColumnIndex ?? 0), 1);
    assert.equal(fields, 'userEnteredValue');
    assert.equal(rows[0]?.values?.length, 1);
  }
});

test('an edit below an insert is still emitted before it', () => {
  const requests = toRequests(writesFor(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 })], fx.insertAt(fx.end, 3)), fx.grid));
  assert.deepEqual(kinds(requests).slice(0, 2), [`write@${fx.at.fargoS2}`, 'insert']);
});

// The case a single ordering rule gets wrong. The fill shares a row index with
// the insert, so "edits before inserts" would write the fill over whatever
// currently sits there and *then* insert a blank row below it.
test('an insert precedes its own fill, which shares the same row index', () => {
  const requests = toRequests(writesFor(planOf([], fx.insertAt(fx.end, 3)), fx.grid));
  assert.equal(kinds(requests)[0], 'insert');
  assert.ok(kinds(requests).slice(1).every((k) => k === `write@${fx.end}`));
});

// deleteDimension shifts every row beneath it, so the deletes go bottom-up and
// no index moves under one that has not run yet.
test('row deletions are emitted descending', () => {
  assert.deepEqual(
    deleteRowRequests(1, [4, 40, 9]).map((r) => ('deleteDimension' in r ? r.deleteDimension.range.startIndex : -1)),
    [40, 9, 4],
  );
});

// The builder reads only row, column and value, so a third field on one row is
// structurally the same as the two it already emits. Pinned rather than assumed:
// this is what says the request builder needed no change for the runtime write.
test('a season closing with its runtime emits three cell writes on one row', () => {
  const plan = planOf([
    fx.cell('fargoS2', 'Episode', { numberValue: 10 }),
    fx.cell('fargoS2', 'End', { numberValue: TODAY }),
    fx.cell('fargoS2', 'Episodes', { numberValue: 49 / 1440 }),
  ]);
  const requests = toRequests(writesFor(plan, fx.grid));
  assert.equal(requests.length, 3);
  const columns = requests.map((r) => ('updateCells' in r ? r.updateCells.range.startColumnIndex : -1));
  assert.deepEqual(
    columns,
    [fx.grid.columns.Episodes, fx.grid.columns.End, fx.grid.columns.Episode].sort((a, b) => b - a),
    'all three are cell writes, descending by column',
  );
});
