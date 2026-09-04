import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridError, parseMovieGrid, parseMovieId } from '../../../src/sheet/movies/2-grid.ts';
import { cellOf, filmRow, MOVIE_SHEET_HEADERS, sheetSnapshot } from '../../helpers.ts';
import { film, filmGrid, rawFilm } from './fixture.ts';

test('a film row is one row, matched by the id its cell holds as text', () => {
  const fx = filmGrid(film('a', { id: 53078 }), film('b', { id: 53080 }));
  assert.deepEqual(
    fx.grid.rows.map((r) => r.id),
    [53078, 53080],
  );
  assert.equal(fx.grid.rows[0]?.row, 1);
});

test('an id stored as a number reads the same as one stored as text', () => {
  assert.equal(parseMovieId(cellOf('53078')), 53078);
  assert.equal(parseMovieId(cellOf(53078)), 53078);
});

test('a blank, zero or non-numeric id is no id rather than an error', () => {
  for (const spec of [null, '', 'tt0076759', 0, -1, 1.5]) assert.equal(parseMovieId(cellOf(spec)), null);
});

test('the tab is recognised by its own header labels, not by the show grid labels', () => {
  const rows = [['Sheet title', null], MOVIE_SHEET_HEADERS, filmRow({ id: 1 })];
  assert.equal(parseMovieGrid(sheetSnapshot(rows)).rows.length, 1);
});

test('columns are resolved by label, so reordering them changes nothing', () => {
  const shuffled = [...MOVIE_SHEET_HEADERS].reverse();
  const cells = filmRow({ id: 7, score: 9 });
  const rows = [shuffled, [...cells].reverse()];
  const grid = parseMovieGrid(sheetSnapshot(rows));
  assert.equal(grid.rows[0]?.id, 7);
  assert.equal(grid.columns.Score, shuffled.indexOf('Score'));
});

test('a missing column is refused rather than guessed at', () => {
  const rows = [MOVIE_SHEET_HEADERS.map((h) => (h === 'Banner' ? 'Backdrop' : h)), filmRow({ id: 1 })];
  assert.throws(() => parseMovieGrid(sheetSnapshot(rows)), /Banner is missing/);
});

test('a duplicated column is refused: which one holds Score is unanswerable', () => {
  const rows = [MOVIE_SHEET_HEADERS.map((h) => (h === 'Runtime' ? 'Score' : h)), filmRow({ id: 1 })];
  assert.throws(() => parseMovieGrid(sheetSnapshot(rows)), /Score appears in/);
});

test('a tab with no recognisable header row fails closed', () => {
  assert.throws(() => parseMovieGrid(sheetSnapshot([['a', 'b'], ['c', 'd']])), GridError);
});

test('the blank tail is not data, but a row with only a name is', () => {
  const fx = filmGrid(film('real', { id: 1 }), rawFilm('started', ['Half Typed', null, null, null, null, null, null, null, null, null, null, null, null, null]));
  assert.equal(fx.grid.rows.length, 2);
  // A row someone began by hand must be seen, or the sync inserts a second
  // row for the same film beneath it.
  assert.equal(fx.grid.rows[1]?.name, 'Half Typed');
  assert.equal(fx.grid.rows[1]?.id, null);
});

test('an id on two rows is recorded as a duplicate rather than resolved', () => {
  const fx = filmGrid(film('a', { id: 42 }), film('b', { id: 42 }));
  assert.deepEqual([...fx.grid.duplicates], [42]);
});
