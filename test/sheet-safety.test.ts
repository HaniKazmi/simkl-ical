import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a1, parseGrid, type Grid, type HeaderName } from '../src/sheet/grid.ts';
import { assertPlanSafe, deleteRowRequests, toRequests, UnsafePlanError } from '../src/sheet/safety.ts';
import { dateSerial } from '../src/sheet/progress.ts';
import type { CellEdit, RowInsert, SheetPlan } from '../src/sheet/plan.ts';
import type { ExtendedValue } from '../src/sheets/types.ts';
import { sheetSnapshot, SHEET_HEADERS, type CellSpec } from './helpers.ts';

const H = SHEET_HEADERS;
const TODAY = dateSerial(new Date().toISOString().slice(0, 10));

const show = (title: string, status: string): CellSpec[] =>
  [title, status, { formula: '=LET(…)', value: 1 }, { formula: '=LET(…)', value: 1 }, 45000, { formula: '=LET(…)' }, { formula: '=LET(…)' }, { formula: '=LET(…)' }, 1, 'show'];
const season = (n: number, episodes: number | null, end: number | null): CellSpec[] =>
  [null, null, n, episodes, 45000, end, 0.0153, { formula: '=G*F' }, null, null];

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

const planOf = (edits: CellEdit[] = [], inserts: RowInsert[] = []): SheetPlan => ({ edits, inserts, skipped: [], notes: [] });

const refuses = (plan: SheetPlan, pattern: RegExp): void => assert.throws(() => assertPlanSafe(plan, grid), (err: Error) => err instanceof UnsafePlanError && pattern.test(err.message));

// The baseline the rest of the file varies from: this must pass, or every
// assertion below is vacuous.
test('an ordinary count advance on an open season is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([cell(3, 'Episode', { numberValue: 8 })]), grid));
});

// --- what may be written, and where ---------------------------------------

test('a formula target is refused unconditionally', () => {
  refuses(planOf([cell(1, 'Episode', { numberValue: 9 })]), /is a formula/);
  refuses(planOf([cell(3, 'Length', { numberValue: 1 })]), /not a field this sync may write/);
});

test('Status may only be written on a show row, and the other two only on season rows', () => {
  refuses(planOf([cell(3, 'Status', { stringValue: 'Ended' })]), /only be written on a show row/);

  // A show row whose derived cells are literals rather than formulas — the
  // sheet's pre-conversion state. The formula guard cannot fire here, so this
  // is what proves the row-kind guard stands on its own.
  const literal = parseGrid(sheetSnapshot([H, ['Fargo', 'Ended', 1, 6, 45000, 44000, 6, 0.1, 1, 'show'], season(1, 6, null)]));
  assert.throws(
    () => assertPlanSafe(planOf([{ ...cell(1, 'End', { numberValue: TODAY }), previous: { numberValue: 44000 } }]), literal),
    /only be written on a season row/,
  );
});

test('a field outside the whitelist is refused however plausible', () => {
  refuses(planOf([cell(3, 'Start', { numberValue: TODAY })]), /not a field this sync may write/);
  refuses(planOf([cell(3, 'Season', { numberValue: 3 })]), /not a field this sync may write/);
  refuses(planOf([cell(1, 'Show', { stringValue: 'Renamed' })]), /not a field this sync may write/);
  refuses(planOf([cell(3, 'id', { numberValue: 7 })]), /not a field this sync may write/);
});

test('a closed season is never touched, whatever the field', () => {
  refuses(planOf([cell(2, 'Episode', { numberValue: 9 })]), /already has an end date/);
  refuses(planOf([cell(2, 'End', { numberValue: TODAY })]), /already has an end date/);
});

// The user's rule, and the reason a wrong-but-*larger* number is the dangerous
// failure: a smaller one is caught here, a larger one is not.
test('a count never goes backwards, or sideways', () => {
  refuses(planOf([cell(3, 'Episode', { numberValue: 2 })]), /would not increase/);
  refuses(planOf([cell(3, 'Episode', { numberValue: 3 })]), /would not increase/);
  refuses(planOf([cell(3, 'Episode', { numberValue: 0 })]), /positive whole number/);
});

test('an implausible date serial is refused at both ends', () => {
  refuses(planOf([cell(3, 'End', { numberValue: 1000 })]), /not a plausible date serial/);
  refuses(planOf([cell(3, 'End', { numberValue: TODAY + 5 })]), /not a plausible date serial/);
  refuses(planOf([cell(3, 'End', { stringValue: '2026-08-15' })]), /not a plausible date serial/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([cell(3, 'End', { numberValue: TODAY })]), grid));
});

// A mismatch means the plan was built against a different grid, which is the one
// failure that produces real writes in the wrong places.
test('a cell that has moved under the plan is refused', () => {
  refuses(planOf([cell(3, 'Episode', { numberValue: 8 }, { numberValue: 99 })]), /no longer holds what the plan was built on/);
});

test('an address that does not match its own target is refused', () => {
  const bad = { ...cell(3, 'Episode', { numberValue: 8 }), address: 'Z1' };
  refuses(planOf([bad]), /does not match the target/);
  const displaced = { ...cell(3, 'Episode', { numberValue: 8 }), column: 99 };
  refuses(planOf([displaced]), /does not match the resolved position/);
});

// --- budget ----------------------------------------------------------------

// Over budget refuses the whole plan. Truncating would apply half of what is,
// by hypothesis, a wrong plan.
test('over budget refuses everything rather than trimming', () => {
  const many = Array.from({ length: 5 }, () => cell(3, 'Episode', { numberValue: 8 }));
  assert.throws(() => assertPlanSafe(planOf(many), grid, { maxEdits: 4 }), /exceeds SHEET_MAX_EDITS=4/);
  assert.throws(() => assertPlanSafe(planOf(many), grid, { maxRows: 0 }), /exceeds SHEET_MAX_ROWS=0/);
});

// --- inserts ---------------------------------------------------------------

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

test('a well-formed insert below an existing season row is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [insertAt(4, 3)]), grid));
});

// inheritFromBefore takes its formats from the row above. Without a season row
// there it inherits the show row's, and a correct date serial renders as 46265.
test('an insert with no season row above it is refused', () => {
  refuses(planOf([], [insertAt(2, 1)]), /no season row above the insertion point/);
});

test('an insert outside its own block is refused', () => {
  const two = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended'), season(1, 6, 44000), show('Silo', 'Watching'), season(1, 3, null)]));
  const insert = { ...insertAt(2, 2), row: 4 };
  assert.throws(() => assertPlanSafe(planOf([], [{ ...insert, fill: insert.fill.map((f) => ({ ...f, row: 4 })) }]), two), /not inside Fargo's block/);
});

test('a fractional or season-zero row is never inserted', () => {
  refuses(planOf([], [insertAt(4, 4.5)]), /only whole numbered seasons/);
  refuses(planOf([], [insertAt(4, 0)]), /only whole numbered seasons/);
});

// A separate whitelist from the edits one: an insert fills six columns, and
// folding the two together would either forbid it or widen ordinary edits.
test('an insert may only fill its own whitelist, and only its own row', () => {
  const insert = insertAt(4, 3);
  const strayField = { ...insert, fill: [...insert.fill, { ...insert.fill[0]!, field: 'Status' as HeaderName, column: grid.columns.Status, address: a1(4, grid.columns.Status) }] };
  refuses(planOf([], [strayField]), /not a field this sync may write/);

  const strayRow = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, row: 3, address: a1(3, f.column) } : f)) };
  refuses(planOf([], [strayRow]), /may only fill the row it creates/);

  const hasPrevious = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, previous: { numberValue: 1 } } : f)) };
  refuses(planOf([], [hasPrevious]), /cannot have a previous value/);
});

// --- request ordering ------------------------------------------------------

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

// Past the end of the snapshot both sides read as undefined, so the value
// comparison would agree with itself and wave the write through.
test('a target beyond the end of the snapshot is refused', () => {
  refuses(planOf([{ ...cell(3, 'Episode', { numberValue: 8 }), row: 99, address: a1(99, grid.columns.Episode), previous: undefined }]), /outside the snapshot/);
});
