import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a1, parseGrid, type HeaderName } from '../src/sheet/grid.ts';
import { shiftRow, verify } from '../src/sheet/verify.ts';
import type { CellEdit, SheetPlan } from '../src/sheet/plan.ts';
import { cellOf, sheetSnapshot, SHEET_HEADERS, type CellSpec } from './helpers.ts';

const H = SHEET_HEADERS;

const show = (title: string, status: string): CellSpec[] =>
  [title, status, { formula: '=LET(…)', value: 1 }, { formula: '=LET(…)', value: 6 }, 45000, { formula: '=LET(…)' }, { formula: '=LET(…)', value: 6 }, { formula: '=LET(…)' }, 1, 'show'];
const season = (n: number, episodes: number | null, end: number | null): CellSpec[] =>
  [null, null, n, episodes, 45000, end, 0.0153, { formula: '=G*F' }, null, null];

const ROWS: CellSpec[][] = [H, show('Fargo', 'Ended'), season(1, 6, 44000), season(2, 3, null)];
const before = parseGrid(sheetSnapshot(ROWS));

const editOf = (row: number, field: HeaderName, value: number | string): CellEdit => ({
  row,
  column: before.columns[field],
  field,
  previous: before.snapshot.rows[row]?.[before.columns[field]]?.userEnteredValue,
  value: typeof value === 'number' ? { numberValue: value } : { stringValue: value },
  address: a1(row, before.columns[field]),
  note: 'test',
});

/** Apply a change to a copy of the fixture, the way a real write would. */
const withChange = (row: number, field: HeaderName, spec: CellSpec) => {
  const rows = ROWS.map((r) => [...r]);
  rows[row]![before.columns[field]] = spec;
  return sheetSnapshot(rows);
};

const planOf = (edits: CellEdit[] = [], inserts: SheetPlan['inserts'] = []): SheetPlan => ({ edits, inserts, skipped: [], notes: [] });

test('a shift maps a pre-existing row to where the inserts leave it', () => {
  assert.equal(shiftRow(3, []), 3);
  assert.equal(shiftRow(3, [4]), 3);
  assert.equal(shiftRow(4, [4]), 5);
  assert.equal(shiftRow(9, [4, 6]), 11);
});

test('the planned write, and only the planned write, verifies', () => {
  const result = verify(before, withChange(3, 'Episode', 8), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.restores, []);
});

// This is why the diff is on userEnteredValue and never effectiveValue: writing
// a season's Episode recalculates five formulas on the show row above it.
test('a formula recalculating is not a change', () => {
  const rows = ROWS.map((r) => [...r]);
  rows[3]![before.columns.Episode] = 8;
  // The show row's roll-up now reads 14 instead of 6, with the formula intact.
  rows[1]![before.columns.Episodes] = { formula: '=LET(…)', value: 14 };
  const result = verify(before, sheetSnapshot(rows), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, true, result.problems.join('; '));
});

// A concurrent human, or us being wrong about row alignment. Both mean stop.
test('an unplanned change fails and is offered back for restore', () => {
  const result = verify(before, withChange(2, 'Episode', 99), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /D3: changed without being planned/);
  assert.deepEqual(result.restores, [{ row: 2, column: before.columns.Episode, value: { numberValue: 6 } }]);
});

test('a planned write that did not land fails', () => {
  const result = verify(before, sheetSnapshot(ROWS), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /did not land/);
});

// The join key is never written by design, so a change to it means the rows are
// not the rows we think they are.
test('an id that moved fails even though id is outside the inspected columns', () => {
  const result = verify(before, withChange(1, 'id', 999), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /the id changed/);
});

// Free, because the read already carries it: a formula the write broke.
test('a new error value fails', () => {
  const rows = ROWS.map((r) => [...r]);
  rows[3]![before.columns.Episode] = 8;
  const after = sheetSnapshot(rows);
  after.rows[1]![before.columns.Episodes] = { userEnteredValue: { formulaValue: '=LET(…)' }, effectiveValue: { errorValue: { type: 'REF' } } };
  const result = verify(before, after, planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /now holds an error value/);
});

test('a header that moved during the write fails before anything else is inspected', () => {
  const shuffled = [...H];
  [shuffled[3], shuffled[5]] = [shuffled[5]!, shuffled[3]!];
  const after = sheetSnapshot([shuffled, ...ROWS.slice(1)]);
  const result = verify(before, after, planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /column moved during the write/);
});

// --- inserts ---------------------------------------------------------------

const insertFixture = () => {
  const newRow: CellSpec[] = [null, null, 3, 4, 45500, null, 0.0153, { formula: '=G5*D5' }, null, null];
  const after = sheetSnapshot([...ROWS, newRow]);
  const fill = (['Season', 'Episode', 'Start', 'Episodes', 'Length'] as HeaderName[]).map((field) => ({
    row: 4,
    column: before.columns[field],
    field,
    previous: undefined,
    value: cellOf(newRow[before.columns[field]]!).userEnteredValue!,
    address: a1(4, before.columns[field]),
    note: 'new',
  }));
  return { after, plan: planOf([], [{ row: 4, title: 'Fargo', season: 3, fill, note: 'new row' }]) };
};

test('an insert with exactly its planned fill verifies', () => {
  const { after, plan } = insertFixture();
  const result = verify(before, after, plan);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.deleteRows, []);
});

test('a row the sheet did not grow by fails', () => {
  const { plan } = insertFixture();
  const result = verify(before, sheetSnapshot(ROWS), plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /grew by 0 rows, not 1/);
});

// The one catastrophic failure mode: rows below the insert land one off.
test('a one-row misalignment is caught, and the inserted row is offered for deletion', () => {
  const { plan } = insertFixture();
  // The insert landed a row too high, so the real season 2 row is now at 5.
  const misaligned = sheetSnapshot([...ROWS.slice(0, 3), [null, null, 3, 4, 45500, null, 0.0153, { formula: '=G4*D4' }, null, null], ROWS[3]!]);
  const result = verify(before, misaligned, plan);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleteRows, [4]);
  assert.ok(result.restores.length > 0);
});

test('a show row that lost its title fails, because it silently merges two blocks', () => {
  const result = verify(before, withChange(1, 'Show', null), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
});
