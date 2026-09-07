import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridError, parseBookGrid } from '../../../src/sheet/books/2-grid.ts';
import { BOOK_SHEET_HEADERS, bookRow, MOVIE_SHEET_HEADERS, sheetSnapshot } from '../../helpers.ts';

const grid = (rows: ReturnType<typeof bookRow>[]) => parseBookGrid(sheetSnapshot([BOOK_SHEET_HEADERS, ...rows]));

test('the header is found by Title and Author together', () => {
  const parsed = grid([bookRow({ name: '1984', id: 379760 })]);
  assert.deepEqual(
    parsed.rows.map((r) => [r.name, r.id]),
    [['1984', 379760]],
  );
});

test('the films tab is not mistaken for this one', () => {
  // `Title` alone is carried by all three tabs, so it cannot identify one.
  // `Author` is this tab's own; the films tab's equivalent is `Director`.
  assert.throws(() => parseBookGrid(sheetSnapshot([MOVIE_SHEET_HEADERS])), GridError);
});

test('an id parses whether the cell holds a number or text', () => {
  // Every one of the 401 live rows stores its id as a number, where every one
  // of the films tab's stores it as text. A parser written for one tab and
  // reused on the other reads every row as having no id.
  assert.equal(grid([bookRow({ id: 379760 })]).rows[0]?.id, 379760);
  assert.equal(grid([bookRow({ id: '379760' })]).rows[0]?.id, 379760);
});

test('an id that is not a positive integer is no id at all', () => {
  for (const id of [null, 0, -3, 'nope', 1.5]) {
    assert.equal(grid([bookRow({ id })]).rows[0]?.id, null, String(id));
  }
});

test('an id on two rows is a duplicate, and the page cannot address either', () => {
  const parsed = grid([bookRow({ name: 'A', id: 7 }), bookRow({ name: 'B', id: 7 }), bookRow({ name: 'C', id: 8 })]);
  assert.deepEqual([...parsed.duplicates], [7]);
});

test('the blank tail is skipped, and a half-filled row is still a book', () => {
  const parsed = parseBookGrid(
    sheetSnapshot([
      BOOK_SHEET_HEADERS,
      bookRow({ name: 'Real', id: 1 }),
      // Started by hand: a title and nothing else. It is a row, and the page
      // must list it rather than behave as though the book is absent.
      bookRow({ name: 'Started', author: null, ended: null, status: null }),
      [],
      [],
    ]),
  );
  assert.deepEqual(
    parsed.rows.map((r) => r.name),
    ['Real', 'Started'],
  );
});

test('a tab missing the Artwork column fails the parse rather than degrading', () => {
  // The films behaviour, not the show tab's: `Banner` is a required field
  // here, so there is no state in which the page silently lists rows it can
  // never write to.
  const headers = BOOK_SHEET_HEADERS.filter((h) => h !== 'Artwork');
  assert.throws(() => parseBookGrid(sheetSnapshot([headers])), GridError);
});

test('the Artwork cell and the dates are addressable by column', () => {
  const parsed = grid([bookRow({ id: 1, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/a.jpg', released: 18057, started: 40056, ended: 40061 })]);
  const row = parsed.rows[0]?.row ?? -1;
  assert.equal(parsed.snapshot.rows[row]?.[parsed.columns.Banner]?.userEnteredValue?.stringValue, 'https://wsrv.nl/?url=https://assets.hardcover.app/a.jpg');
  assert.equal(parsed.snapshot.rows[row]?.[parsed.columns['End Date']]?.userEnteredValue?.numberValue, 40061);
});
