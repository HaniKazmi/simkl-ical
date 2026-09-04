import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFilms } from '../../../src/sheet/movies/7-verify.ts';
import { parseMovieGrid } from '../../../src/sheet/movies/2-grid.ts';
import { cellOf, filmRow, MOVIE_SHEET_HEADERS, sheetSnapshot, type CellSpec } from '../../helpers.ts';
import { ffx, filmPlanOf, TODAY } from './fixture.ts';
import type { SheetSnapshot } from '../../../src/sheet/io/spreadsheet.ts';

const BASE: CellSpec[][] = [
  MOVIE_SHEET_HEADERS,
  filmRow({ name: 'Star Wars', id: 53078, watched: 39487, score: 8, runtime: 121, genre: 'Sci-Fi' }),
  filmRow({ name: 'Finding Nemo', id: 53080, watched: 38395, score: 6, runtime: 100, genre: 'Adventure' }),
];

/** The tab as it looks after `edit` was applied to it. */
const after = (mutate: (rows: CellSpec[][]) => void = () => {}): SheetSnapshot => {
  const rows = BASE.map((row) => [...row]);
  mutate(rows);
  return sheetSnapshot(rows);
};

const SCORE = MOVIE_SHEET_HEADERS.indexOf('Score');

test('a write that landed exactly as planned verifies', () => {
  const plan = filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 10 })]);
  const result = verifyFilms(ffx.grid, after((rows) => void (rows[1]![SCORE] = 10)), plan);
  assert.deepEqual(result.problems, []);
  assert.ok(result.ok);
  assert.ok(result.landed);
});

test('a planned write missing from the sheet does not verify', () => {
  const plan = filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 10 })]);
  const result = verifyFilms(ffx.grid, after(), plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /did not land/);
  // Nothing reached the sheet, so there is nothing to roll back.
  assert.equal(result.landed, false);
});

test('a cell that changed without being planned does not verify', () => {
  const plan = filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 10 })]);
  const result = verifyFilms(
    ffx.grid,
    after((rows) => {
      rows[1]![SCORE] = 10;
      rows[2]![0] = 'Renamed By Hand';
    }),
    plan,
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /changed without being planned/);
});

test('an id that changed is always a problem — that is a row shifting under us', () => {
  // The shape a row deleted between the read and the write leaves behind.
  const shifted = sheetSnapshot([MOVIE_SHEET_HEADERS, BASE[2]!, BASE[2]!]);
  const result = verifyFilms(ffx.grid, shifted, filmPlanOf());
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /the id changed/);
});

test('a row count that does not match the plan stops before the cell diff', () => {
  const grown = sheetSnapshot([...BASE, filmRow({ name: 'Extra', id: 1 })]);
  const result = verifyFilms(ffx.grid, grown, filmPlanOf());
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /grew by 1 rows, not 0/);
});

test('an insert verifies when the row holds exactly its fill', () => {
  const insert = ffx.insert({ id: 999, title: 'A New Film' });
  const landed = sheetSnapshot([...BASE, filmRow({ name: 'A New Film', id: 999, watched: TODAY - 1 })]);
  const result = verifyFilms(ffx.grid, landed, filmPlanOf([], insert));
  assert.deepEqual(result.problems, []);
  assert.ok(result.landed);
  // Nothing to delete while the write is good.
  assert.deepEqual(result.deleteRows, []);
});

test('an inserted row carrying a value nothing planned does not verify, and is deleted', () => {
  const insert = ffx.insert({ id: 999, title: 'A New Film' });
  const landed = sheetSnapshot([...BASE, filmRow({ name: 'A New Film', id: 999, watched: TODAY - 1, score: 9 })]);
  const result = verifyFilms(ffx.grid, landed, filmPlanOf([], insert));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /carries a value nothing planned/);
  assert.deepEqual(result.deleteRows, [3], 'and the rollback knows which row it created');
});

test('an insert whose row landed but whose cells did not is not claimed as ours', () => {
  // Strict on purpose, and with a cost worth stating: the row is left in place
  // and the run freezes rather than deleting a row this read cannot positively
  // identify as the sync's. A partial match would trade a rare manual repair
  // for a rarer deletion of a row nobody created.
  const insert = ffx.insert({ id: 999, title: 'A New Film' });
  const partial = sheetSnapshot([...BASE, filmRow({ name: 'A New Film', id: 999, watched: null })]);
  const result = verifyFilms(ffx.grid, partial, filmPlanOf([], insert));
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleteRows, [], 'nothing is deleted on a row we cannot claim');
});

test('a tab that no longer parses is a problem, not a throw', () => {
  const broken = sheetSnapshot([['nothing', 'recognisable']]);
  const result = verifyFilms(ffx.grid, broken, filmPlanOf());
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /no longer parses/);
  // Conservatively true: the sheet could not be inspected at all.
  assert.ok(result.landed);
});

test('a column that moved during the write is caught before any cell is compared', () => {
  const moved = MOVIE_SHEET_HEADERS.map((h) => h);
  [moved[2], moved[4]] = [moved[4]!, moved[2]!];
  const result = verifyFilms(ffx.grid, sheetSnapshot([moved, BASE[1]!, BASE[2]!]), filmPlanOf());
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /column moved during the write/);
});

test('a cell newly holding an error value does not verify', () => {
  const rows = BASE.map((row) => [...row]);
  const snapshot = sheetSnapshot(rows);
  snapshot.rows[1]![SCORE] = { ...cellOf(8), effectiveValue: { errorValue: { type: 'REF', message: 'boom' } } };
  const result = verifyFilms(ffx.grid, snapshot, filmPlanOf());
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /error value/);
});

test('a film row losing every cell is caught — it would be re-inserted next poll', () => {
  const emptied = BASE.map((row) => [...row]);
  emptied[2] = MOVIE_SHEET_HEADERS.map(() => null);
  const result = verifyFilms(ffx.grid, parseMovieGrid(sheetSnapshot(emptied)).snapshot, filmPlanOf());
  assert.equal(result.ok, false);
  // Named on its own. An alternation with "changed without being planned"
  // proves nothing: blanking a row fires that for every column, so the row-set
  // rule could be deleted outright and the assertion would still hold.
  assert.match(result.problems.join(' '), /set of film rows changed/);
});
