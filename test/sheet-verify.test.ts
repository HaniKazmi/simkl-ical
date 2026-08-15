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
  assert.equal(result.unexpected, 0);
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
test('an unplanned change fails and is counted', () => {
  const result = verify(before, withChange(2, 'Episode', 99), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /D3: changed without being planned/);
  // The count is what tells a batch that never landed from one that landed
  // wrongly; the cells themselves come back from the snapshot tab.
  assert.equal(result.unexpected, 1);
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
  assert.ok(result.unexpected > 0);
});

test('a show row that lost its title fails, because it silently merges two blocks', () => {
  const result = verify(before, withChange(1, 'Show', null), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
});

// --- formula rewriting on insert ------------------------------------------
//
// The failure that corrupted the first real apply run. Inserting a row shifts
// every row beneath it and Sheets rewrites the relative A1 references in every
// affected formula. Verify read those rewrites as ~1500 unplanned changes, and
// the rollback then wrote the pre-insert text back *and* deleted the row in one
// batch — so the delete rewrote it again, one row off.
//
// The earlier insert tests missed it twice over: they appended at the end, so
// nothing shifted, and their formulas carried no row numbers to rewrite.

/** A block whose formulas name their own rows, the way the real sheet's do. */
const rowsWithFormulas = (): CellSpec[][] => [
  H,
  ['Fargo', 'Ended', { formula: '=LET(h,MATCH("*",OFFSET($A2,1,0,40),0)-1,OFFSET($E2,h,0))', value: 2 }, { formula: '=LET(…$F2…)', value: 6 }, 45000, { formula: '=LET(…$H2…)' }, { formula: '=LET(…$F2…)', value: 12 }, { formula: '=LET(…$J2…)' }, 1, 'show'],
  [null, null, 1, 6, 45000, 44000, 0.0153, { formula: '=G3*D3' }, null, null],
  [null, null, 3, 4, 45500, null, 0.0153, { formula: '=G4*D4' }, null, null],
];

/** What Sheets returns after inserting at index 3: rows below shift and rewrite. */
const afterInsertAt3 = (): CellSpec[][] => {
  const rows = rowsWithFormulas();
  const shifted: CellSpec[][] = [
    ...rows.slice(0, 3),
    [null, null, 2, 5, 45400, null, 0.0153, { formula: '=G4*D4' }, null, null], // the new row
    [null, null, 3, 4, 45500, null, 0.0153, { formula: '=G5*D5' }, null, null], // was row 4, rewritten
  ];
  return shifted;
};

const insertPlan = (before: ReturnType<typeof parseGrid>): SheetPlan => ({
  edits: [],
  inserts: [
    {
      row: 3,
      title: 'Fargo',
      season: 2,
      fill: (['Season', 'Episode', 'Start', 'Episodes', 'Length'] as HeaderName[]).map((field) => ({
        row: 3,
        column: before.columns[field],
        field,
        previous: undefined,
        value: cellOf(afterInsertAt3()[3]![before.columns[field]]!).userEnteredValue!,
        address: a1(3, before.columns[field]),
        note: 'new',
      })),
      note: 'new row',
    },
  ],
  skipped: [],
  notes: [],
});

test("a formula Sheets rewrote because the row moved is not an unplanned change", () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));
  const result = verify(grid, sheetSnapshot(afterInsertAt3()), insertPlan(grid));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.unexpected, 0);
  assert.deepEqual(result.deleteRows, []);
});

// The exemption is narrow on purpose: it accepts a formula that is still a
// formula, and nothing else. A literal moving is still what catches a
// misalignment, and every literal on a season row moves with the row.
test('the rewrite exemption does not cover a literal, or a formula replaced by one', () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));

  const literalMoved = afterInsertAt3();
  literalMoved[4]![grid.columns.Start] = 99999;
  const a = verify(grid, sheetSnapshot(literalMoved), insertPlan(grid));
  assert.equal(a.ok, false);
  assert.match(a.problems.join('; '), /changed without being planned/);

  const flattened = afterInsertAt3();
  flattened[4]![grid.columns.Length] = 42;
  const b = verify(grid, sheetSnapshot(flattened), insertPlan(grid));
  assert.equal(b.ok, false, 'a roll-up replaced by a frozen number must not pass');
});

// With no insert there is nothing to rewrite, so the strict comparison stands —
// which is what the rollback relies on once the inserted row has been deleted.
test('without an insert a changed formula is still a change', () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));
  const tampered = rowsWithFormulas();
  tampered[3]![grid.columns.Length] = { formula: '=G99*D99' };
  const result = verify(grid, sheetSnapshot(tampered), { edits: [], inserts: [], skipped: [], notes: [] });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /H4: changed without being planned/);
});
