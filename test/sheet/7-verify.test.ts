import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a1, parseGrid, type HeaderName } from '../../src/sheet/2-grid.ts';
import { shiftRow, verify } from '../../src/sheet/7-verify.ts';
import type { CellEdit, SheetPlan } from '../../src/sheet/4-plan.ts';
import { cellOf, col, rowByLabel, seasonRow, sheetSnapshot, type CellSpec } from '../helpers.ts';
import { fx, H, planOf } from './fixture.ts';

const before = fx.grid;

/** `fx.cell` with the bare value this suite finds easier to write. */
const editOf = (row: string, field: HeaderName, value: number | string): CellEdit =>
  fx.cell(row, field, typeof value === 'number' ? { numberValue: value } : { stringValue: value });

/** Apply a change to a copy of the fixture, the way a real write would. */
const withChange = (row: string, field: HeaderName, spec: CellSpec) => {
  const rows = fx.rows.map((r) => [...r]);
  rows[fx.at[row]!]![before.columns[field]] = spec;
  return sheetSnapshot(rows);
};

test('a shift maps a pre-existing row to where the inserts leave it', () => {
  assert.equal(shiftRow(3, []), 3);
  assert.equal(shiftRow(3, [4]), 3);
  assert.equal(shiftRow(4, [4]), 5);
  assert.equal(shiftRow(9, [4, 6]), 11);
});

test('the planned write, and only the planned write, verifies', () => {
  const result = verify(before, withChange('fargoS2', 'Episode', 8), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.landed, true);
});

// The one write that removes a value instead of replacing one. Sheets may
// echo an emptied cell as an absent `userEnteredValue` or as an empty one, and
// `sameValue` calls those two different — read strictly, a correct clear looks
// like a write that did not land, and the batch is rolled back and re-planned
// identically on the next poll, for ever.
test('a cleared cell verifies however the read spells "nothing"', () => {
  const noted = sheetSnapshot(fx.rows.map((r, i) => (i === fx.at.fargoS2 ? r.map((c, j) => (j === before.columns.Note ? '2024-01-01' : c)) : [...r])));
  const grid = parseGrid(noted);
  const clear: CellEdit = { ...fx.cell('fargoS2', 'Note', undefined), previous: { stringValue: '2024-01-01' } };

  for (const [spelling, cell] of [
    ['omitted', {}],
    ['an empty value', { userEnteredValue: {} }],
  ] as const) {
    const after = noted.rows.map((r) => [...r]);
    after[fx.at.fargoS2!]![before.columns.Note] = cell;
    const result = verify(grid, { ...noted, rows: after }, planOf([clear]));
    assert.equal(result.ok, true, `${spelling}: ${result.problems.join('; ')}`);
    assert.equal(result.landed, true, `${spelling}: the emptied cell is the write, and it is there`);
  }
});

// Why the diff is on userEnteredValue, never effectiveValue: writing a
// season's Episode recalculates the show row's Episode roll-up above it.
test('a formula recalculating is not a change', () => {
  const rows = fx.rows.map((r) => [...r]);
  rows[fx.at.fargoS2!]![before.columns.Episode] = 8;
  // The show row's roll-up now reads 14 instead of 6, with the formula text
  // itself untouched — the diff is on `userEnteredValue`, so only a changed
  // formula string would count as a change here.
  rows[fx.at.fargo!]![before.columns.Episode] = { formula: '=IF($O2=0,"",SUM(OFFSET($K2,1,0,$O2)))', value: 14 };
  const result = verify(before, sheetSnapshot(rows), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, true, result.problems.join('; '));
});

// A concurrent human, or us being wrong about row alignment. Both mean stop.
test('an unplanned change fails', () => {
  // The planned write landed *and* something else moved — the shape of a
  // concurrent edit, as opposed to a batch that never went out.
  const rows = fx.rows.map((r) => [...r]);
  rows[fx.at.fargoS2!]![before.columns.Episode] = 8;
  rows[fx.at.fargoS1!]![before.columns.Episode] = 99;

  const result = verify(before, sheetSnapshot(rows), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /K3: changed without being planned/);
  assert.equal(result.landed, true);
});

test('a planned write that did not land fails', () => {
  const result = verify(before, sheetSnapshot(fx.rows), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /did not land/);
});

// The join key is never written, so a change to it means the rows are not the
// rows we think they are.
test('an id that moved fails even though id is outside the inspected columns', () => {
  const result = verify(before, withChange('fargo', 'id', 999), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /the id changed/);
});

// A formula the write broke — free to check, the read already carries it.
test('a new error value fails', () => {
  const rows = fx.rows.map((r) => [...r]);
  rows[fx.at.fargoS2!]![before.columns.Episode] = 8;
  const after = sheetSnapshot(rows);
  after.rows[fx.at.fargo!]![before.columns.Episode] = { userEnteredValue: { formulaValue: '=LET(…)' }, effectiveValue: { errorValue: { type: 'REF' } } };
  const result = verify(before, after, planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /now holds an error value/);
});

test('a header that moved during the write fails before anything else is inspected', () => {
  const shuffled = [...H];
  const i = col(H, 'Episodes');
  const j = col(H, 'End Date');
  [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  const after = sheetSnapshot([shuffled, ...fx.rows.slice(1)]);
  const result = verify(before, after, planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /column moved during the write/);
});

// --- inserts ---------------------------------------------------------------

const insertFixture = () => {
  const newRow: CellSpec[] = rowByLabel(H, { Season: 3, Episodes: 4, 'Start Date': 45500, 'Episode Length (min)': 45 });
  const after = sheetSnapshot([...fx.rows, newRow]);
  const fill = (['Season', 'Episode', 'Start', 'Runtime'] as HeaderName[]).map((field) => ({
    row: fx.end,
    column: before.columns[field],
    field,
    previous: undefined,
    value: cellOf(newRow[before.columns[field]]!).userEnteredValue!,
    address: a1(fx.end, before.columns[field]),
    note: 'new',
  }));
  return { after, newRow, plan: planOf([], { row: fx.end, title: 'Fargo', season: 3, fill, note: 'new row' }) };
};

test('an insert with exactly its planned fill verifies', () => {
  const { after, plan } = insertFixture();
  const result = verify(before, after, plan);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.deleteRows, []);
});

// An atomic batch failure looks exactly like this and must not read as landed:
// the caller would hunt for a snapshot tab that rode the same failed batch,
// and freeze over a sheet nothing touched.
test('a row the sheet did not grow by fails, and nothing landed', () => {
  const { plan } = insertFixture();
  const result = verify(before, sheetSnapshot(fx.rows), plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /grew by 0 rows, not 1/);
  assert.equal(result.landed, false);
  assert.deepEqual(result.deleteRows, []);
});

// The one catastrophic failure mode: rows below the insert land one off.
// Nothing is offered for deletion: `deleteRows` may only carry a row this read
// positively identified as ours — every planned cell at exactly the planned
// index — and here that row is the sheet's own. A grid this confused restores
// wholesale or freezes.
test('a one-row misalignment is caught, and no row is offered for deletion', () => {
  const { plan } = insertFixture();
  // The insert landed a row too high, so the real season 2 row is now below it.
  const misplaced: CellSpec[] = rowByLabel(H, { Season: 3, Episodes: 4, 'Start Date': 45500, 'Episode Length (min)': 45 });
  const misaligned = sheetSnapshot([...fx.rows.slice(0, fx.at.fargoS2!), misplaced, fx.rows[fx.at.fargoS2!]!]);
  const result = verify(before, misaligned, plan);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleteRows, []);
});

// The mirror image, and the case a rollback has to handle: the insert landed
// exactly where planned, and something *else* failed verification.
test('an insert that landed where it was planned is offered for deletion', () => {
  const { newRow, plan } = insertFixture();
  const rows = [...fx.rows.map((r) => [...r]), newRow];
  // A concurrent human, on a row the plan never mentioned.
  rows[fx.at.fargoS1!]![before.columns.Episode] = 99;
  const result = verify(before, sheetSnapshot(rows), plan);
  assert.equal(result.ok, false);
  assert.equal(result.landed, true);
  assert.deepEqual(result.deleteRows, [fx.end]);
});

test('a show row that lost its title fails, because it silently merges two blocks', () => {
  const result = verify(before, withChange('fargo', 'Show', null), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
});

// --- formula rewriting on insert ------------------------------------------
//
// Inserting a row shifts every row beneath it, and Sheets rewrites the
// relative A1 references in every formula it shifts. Read as unplanned changes
// those are ~1500, and the rollback they invite writes the pre-insert text
// back beside the delete that shifts it again — one row off.
//
// Season rows carry no formula in the new schema — only a show row's five
// roll-ups do — so the shift that matters here is a *second* show block
// (and its season row) moving down under an insert into the block above it.

/** A show row whose formulas name their own row, the way the real sheet's do. */
const showRowAt = (row: number, title: string, status: string, id: number, episodes: number): CellSpec[] =>
  rowByLabel(H, {
    Title: title,
    Status: status,
    Season: { formula: `=IF($O${row}=0,"",OFFSET($I${row},$O${row},0))`, value: 1 },
    Episodes: { formula: `=IF($O${row}=0,"",SUM(OFFSET($K${row},1,0,$O${row})))`, value: episodes },
    'Start Date': 45000,
    'Seasons / Last Watched': { formula: `=IFERROR(MATCH("*",OFFSET($A${row},1,0,40),0)-1,COUNTA(OFFSET($I${row},1,0,40)))`, value: 1 },
    ID: id,
    Type: 'show',
  });

/** Fargo (rows 1-2), then Silo (rows 3-4) — Silo is what shifts when a row is inserted into Fargo's block. */
const rowsWithFormulas = (): CellSpec[][] => [H, showRowAt(2, 'Fargo', 'Ended', 1, 6), seasonRow(1, 6, 44000), showRowAt(4, 'Silo', 'Watching', 2, 3), seasonRow(1, 3, null)];

/** What Sheets returns after inserting at index 3: Silo's block shifts down and its formulas rewrite. */
const afterInsertAt3 = (): CellSpec[][] => {
  const rows = rowsWithFormulas();
  const inserted: CellSpec[] = rowByLabel(H, { Season: 2, Episodes: 4, 'Start Date': 45500 });
  return [...rows.slice(0, 3), inserted, showRowAt(5, 'Silo', 'Watching', 2, 3), rows[4]!];
};

const insertPlan = (before: ReturnType<typeof parseGrid>): SheetPlan => ({
  edits: [],
  insert: {
    row: 3,
    title: 'Fargo',
    season: 2,
    fill: (['Season', 'Episode', 'Start'] as HeaderName[]).map((field) => ({
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
  skips: [],
  notes: [],
  deferredInserts: 0,
});

test("a formula Sheets rewrote because the row moved is not an unplanned change", () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));
  const result = verify(grid, sheetSnapshot(afterInsertAt3()), insertPlan(grid));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.landed, true);
  assert.deepEqual(result.deleteRows, []);
});

// The exemption accepts a formula still being a formula, and nothing else. A
// moved literal is what catches a misalignment, and every literal on a shifted
// show row moves with the row.
test('the rewrite exemption does not cover a literal, or a formula replaced by one', () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));

  const literalMoved = afterInsertAt3();
  literalMoved[4]![grid.columns.Start] = 99999;
  const a = verify(grid, sheetSnapshot(literalMoved), insertPlan(grid));
  assert.equal(a.ok, false);
  assert.match(a.problems.join('; '), /changed without being planned/);

  const flattened = afterInsertAt3();
  flattened[4]![grid.columns.Episode] = 42;
  const b = verify(grid, sheetSnapshot(flattened), insertPlan(grid));
  assert.equal(b.ok, false, 'a roll-up replaced by a frozen number must not pass');
});

// With no insert there is nothing to rewrite, so the strict comparison stands
// — what the rollback relies on once the inserted row is deleted.
test('without an insert a changed formula is still a change', () => {
  const grid = parseGrid(sheetSnapshot(rowsWithFormulas()));
  const tampered = rowsWithFormulas();
  tampered[3]![grid.columns.Note] = { formula: '=BROKEN()' };
  const result = verify(grid, sheetSnapshot(tampered), { edits: [], insert: null, skips: [], notes: [], deferredInserts: 0 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /O4: changed without being planned/);
});

// The rollback decision reads this, so it must be false only when the sheet
// really is untouched.
test('a write that never went out reads as not landed', () => {
  const result = verify(before, sheetSnapshot(fx.rows), planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.landed, false);
});

// Why counting unplanned changes cannot answer it: the batch landed and broke
// a roll-up, so nothing unplanned moved — yet skipping the rollback would
// discard the only snapshot of the pre-write state.
test('a landed write that broke a formula still reads as landed', () => {
  const rows = fx.rows.map((r) => [...r]);
  rows[fx.at.fargoS2!]![before.columns.Episode] = 8;
  const after = sheetSnapshot(rows);
  after.rows[fx.at.fargo!]![before.columns.Episode] = { userEnteredValue: { formulaValue: '=LET(…)' }, effectiveValue: { errorValue: { type: 'REF' } } };
  const result = verify(before, after, planOf([editOf('fargoS2', 'Episode', 8)]));
  assert.equal(result.ok, false);
  assert.equal(result.landed, true);
});

// `INSPECTED` is derived from HEADERS rather than listed, so a newly written
// column is verified without anyone remembering to add it. These two assert
// that claim.
test('a runtime write verifies like any other edit', () => {
  const plan = planOf([fx.cell('fargoS2', 'Runtime', { numberValue: 49 })]);
  const result = verify(before, withChange('fargoS2', 'Runtime', 49), plan);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.landed, true);
});

test('an unplanned change to a runtime cell is caught', () => {
  const result = verify(before, withChange('fargoS2', 'Runtime', 50), planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 })]));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /changed without being planned/);
});
