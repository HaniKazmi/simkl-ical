import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a1, parseGrid, type HeaderName } from '../../src/sheet/2-grid.ts';
import { shiftRow, verify } from '../../src/sheet/6-verify.ts';
import type { CellEdit, SheetPlan } from '../../src/sheet/3-plan.ts';
import { cellOf, sheetSnapshot, type CellSpec } from '../helpers.ts';
import { cell, grid as before, grid, H, planOf, ROWS } from './fixtures.ts';

/** `cell` with the bare value this suite finds easier to write. */
const editOf = (row: number, field: HeaderName, value: number | string): CellEdit =>
  cell(row, field, typeof value === 'number' ? { numberValue: value } : { stringValue: value });

/** Apply a change to a copy of the fixture, the way a real write would. */
const withChange = (row: number, field: HeaderName, spec: CellSpec) => {
  const rows = ROWS.map((r) => [...r]);
  rows[row]![before.columns[field]] = spec;
  return sheetSnapshot(rows);
};

test('a shift maps a pre-existing row to where the inserts leave it', () => {
  assert.equal(shiftRow(3, []), 3);
  assert.equal(shiftRow(3, [4]), 3);
  assert.equal(shiftRow(4, [4]), 5);
  assert.equal(shiftRow(9, [4, 6]), 11);
});

test('the planned write, and only the planned write, verifies', () => {
  const result = verify(before, withChange(3, 'Episode', 8), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.landed, true);
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
test('an unplanned change fails', () => {
  // The planned write landed *and* something else moved — the real shape of a
  // concurrent edit, and what separates it from a batch that never went out.
  const rows = ROWS.map((r) => [...r]);
  rows[3]![before.columns.Episode] = 8;
  rows[2]![before.columns.Episode] = 99;

  const result = verify(before, sheetSnapshot(rows), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /D3: changed without being planned/);
  assert.equal(result.landed, true);
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
  return { after, newRow, plan: planOf([], [{ row: 4, title: 'Fargo', season: 3, fill, note: 'new row' }]) };
};

test('an insert with exactly its planned fill verifies', () => {
  const { after, plan } = insertFixture();
  const result = verify(before, after, plan);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.deleteRows, []);
});

// An atomic batch failure looks exactly like this, and it must not read as a
// landed write: the caller would go looking for a snapshot tab that rode the
// same failed batch, and freeze over a sheet nothing ever touched.
test('a row the sheet did not grow by fails, and nothing landed', () => {
  const { plan } = insertFixture();
  const result = verify(before, sheetSnapshot(ROWS), plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /grew by 0 rows, not 1/);
  assert.equal(result.landed, false);
  assert.deepEqual(result.deleteRows, []);
});

// The one catastrophic failure mode: rows below the insert land one off.
//
// Nothing is offered for deletion, deliberately. `deleteRows` may only carry a
// row this read positively identified as ours — every planned cell present at
// exactly the planned index — and here the row at that index is the sheet's
// own. Deleting on a guess is the failure the rollback exists to avoid, so a
// grid this confused restores wholesale or freezes.
test('a one-row misalignment is caught, and no row is offered for deletion', () => {
  const { plan } = insertFixture();
  // The insert landed a row too high, so the real season 2 row is now at 5.
  const misaligned = sheetSnapshot([...ROWS.slice(0, 3), [null, null, 3, 4, 45500, null, 0.0153, { formula: '=G4*D4' }, null, null], ROWS[3]!]);
  const result = verify(before, misaligned, plan);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleteRows, []);
});

// The mirror image, and the case a rollback actually has to handle: the insert
// went exactly where it was planned, and something *else* failed verification.
test('an insert that landed where it was planned is offered for deletion', () => {
  const { newRow, plan } = insertFixture();
  const rows = [...ROWS.map((r) => [...r]), newRow];
  // A concurrent human, on a row the plan never mentioned.
  rows[2]![before.columns.Episode] = 99;
  const result = verify(before, sheetSnapshot(rows), plan);
  assert.equal(result.ok, false);
  assert.equal(result.landed, true);
  assert.deepEqual(result.deleteRows, [4]);
});

test('a show row that lost its title fails, because it silently merges two blocks', () => {
  const result = verify(before, withChange(1, 'Show', null), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
});

// --- formula rewriting on insert ------------------------------------------
//
// Inserting a row shifts every row beneath it, and Sheets rewrites the relative
// A1 references in every formula it shifts. Read as unplanned changes those are
// ~1500 of them, and the rollback they invite writes the pre-insert text back
// alongside the delete that shifts it again — one row off.
//
// Two things make a fixture blind to this, and both are easy to write by
// accident: appending at the end, so nothing shifts, and formulas with no row
// numbers in them to rewrite. The fixtures below have neither.

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
  deferred: 0,
});

test("a formula Sheets rewrote because the row moved is not an unplanned change", () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));
  const result = verify(grid, sheetSnapshot(afterInsertAt3()), insertPlan(grid));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.landed, true);
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
  const result = verify(grid, sheetSnapshot(tampered), { edits: [], inserts: [], skipped: [], notes: [], deferred: 0 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /H4: changed without being planned/);
});

// The guard that decides whether to roll back reads this, so it has to be false
// only when the sheet really is untouched.
test('a write that never went out reads as not landed', () => {
  const result = verify(before, sheetSnapshot(ROWS), planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.landed, false);
});

// Why counting unplanned changes cannot answer it: the batch landed and broke a
// roll-up, so nothing *unplanned* moved, yet skipping the rollback here would
// also discard the only snapshot of the pre-write state.
test('a landed write that broke a formula still reads as landed', () => {
  const rows = ROWS.map((r) => [...r]);
  rows[3]![before.columns.Episode] = 8;
  const after = sheetSnapshot(rows);
  after.rows[1]![before.columns.Episodes] = { userEnteredValue: { formulaValue: '=LET(…)' }, effectiveValue: { errorValue: { type: 'REF' } } };
  const result = verify(before, after, planOf([editOf(3, 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.equal(result.landed, true);
});

// `INSPECTED` is derived from HEADERS rather than listed, which is what makes a
// newly written column verified without anyone remembering to add it. These two
// are that claim, asserted rather than trusted.
test('a runtime write verifies like any other edit', () => {
  const plan = planOf([cell(3, 'Episodes', { numberValue: 49 / 1440 })]);
  const after = sheetSnapshot(ROWS.map((row, i) => (i === 3 ? row.map((c, j) => (j === grid.columns.Episodes ? 49 / 1440 : c)) : row)));
  const result = verify(grid, after, plan);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.landed, true);
});

test('an unplanned change to a runtime cell is caught', () => {
  const after = sheetSnapshot(ROWS.map((row, i) => (i === 3 ? row.map((c, j) => (j === grid.columns.Episodes ? 0.99 : c)) : row)));
  const result = verify(grid, after, planOf([cell(3, 'Episode', { numberValue: 8 })]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /changed without being planned/);
});
